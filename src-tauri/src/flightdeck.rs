// Flight Deck - Praxis's mission-control window for parallel Claude Code sessions.
//
// This is the Rust data layer (ported from the old Node `lanes.mjs` sidecar, now
// folded into Praxis so there is no separate process). It reads ONLY real, local
// Claude state - never mock data:
//
//   1. Session manager store  %APPDATA%/Claude/claude-code-sessions/**/local_*.json
//        → the same sessions the Claude app shows you: title, model, cwd, isArchived.
//   2. Live process registry  ~/.claude/sessions/*.json
//        → which sessions have a running process RIGHT NOW (pid registry).
//   3. Transcript tail        ~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl
//        → a one-line "what it's doing now" preview + git branch (tail read only).
//   4. git worktrees          `git -C <repo> worktree list --porcelain`
//        → the real parallel-lane topology: one repo, many worktrees on their own
//          branches. A sibling `*-lanes/README.md` manifest (if present) enriches
//          each lane with its dev port + driver (Max / Cursor / Codex / Pro cloud).
//
// THE MODEL (worktree-aware mission control):
//   • A REPO is a group, identified by its shared git dir (all worktrees of one
//     checkout share one `.git`).
//   • A LANE is a single git worktree on its own branch - OR a declared remote
//     cloud lane (claude.ai/code) that has no local folder.
//   • A SESSION attaches to whichever lane (working dir) it is rooted in.
//
// COLLISION (the only alarm state) = 2+ live BUILD sessions in the SAME working
// dir (same lane). Two sessions in DIFFERENT worktrees of one repo are healthy
// PARALLELISM, not a collision - the deck renders that calm/green.
//
// We deliberately do NOT surface the thousands of historical transcript files or
// archived sessions in the default view (that was the old "a billion sessions"
// confusion). A repo appears once any of its lanes has a live/recent session; we
// then show its WHOLE fleet of worktree lanes (idle ones read as dim runways).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::BufRead as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager};

// ── Tunables ────────────────────────────────────────────────────────────────
const LIVE_MS: u64 = 2 * 60 * 1000; // < 2 min  → live (green)
const RECENT_MS: u64 = 30 * 60 * 1000; // < 30 min → recent (yellow)
                                       // RECENT_MS is purely a STATUS tier (live/recent/dormant + the parked-process
                                       // IDLE rule in the deck client) - see ACTIVE WINDOW below for visibility.

// Archive/account eligibility is applied by the disk adapters. Then the pure
// route_sessions policy classifies owner before applying a time window:
// The owner's Claude sidebar survives without a time limit; his Codex/Cursor cards
// must be within the window or executing. Praxis/automation survive only while
// executing. Placeholder, probe and subagent records never become cards.
/// The ACTIVE WINDOW applies to CODEX and CURSOR sessions only.
///
/// Putting a time filter on top of that would hide sessions that ARE in his sidebar, which is
/// not what he asked for.
///
/// Codex and Cursor have neither an account scope nor any archive discipline -
/// Codex leaves ~700 rollout files on disk forever and Cursor keeps every
/// composer - so for them the window is the only thing standing between the deck
/// and years of history.
const DEFAULT_ACTIVE_WINDOW_MS: u64 = 24 * 60 * 60 * 1000;
/// Window sentinel meaning "no time filter at all" (the deck's "All" option).
const ACTIVE_WINDOW_ALL: u64 = 0;
/// A turn still "in flight" after this long is treated as parked or wedged rather
/// than running. It is deliberately GENEROUS: a single tool call can legitimately
/// run for many minutes (a release build, a long test run) and writes nothing to
/// the transcript while it does, so a tight cap made a genuinely-busy session read
/// as idle - measured live: a 5-minute `tauri build` dropped this very session out
/// of RUNNING.
///
/// A tight cap is not what stops a dead session orbiting anyway - `working` also
/// requires a live process, so a killed session drops out the moment its pid goes.
/// This only catches a live process wedged mid-turn.
const WORKING_STALE_MS: u64 = 30 * 60 * 1000;
const TAIL_BYTES: u64 = 64 * 1024; // how much of each transcript tail to read
const PREVIEW_MAX: usize = 120; // cap for a preview / tail line before it's a card body
const DIFF_CACHE_MS: u64 = 60_000; // per-worktree git diff/ahead cache TTL (refreshed a few lanes per rebuild)
                                   // fd_sessions serves the process-wide cached snapshot within this window, so N
                                   // windows polling = ONE build, and a freshly-opened deck paints instantly.
const SNAP_FRESH_MS: u64 = 2_500;
// Max EXPIRED lane diffs re-shelled per rebuild. ~30 worktrees × 2-3 git spawns
// each took the old build to 40s+; a rolling budget keeps every rebuild seconds
// while still refreshing the whole fleet well inside DIFF_CACHE_MS.
const DIFF_SHELL_BUDGET: i32 = 8;

// Background lanes that write transcripts continuously (the claude-mem observer).
// Matched against the cwd. Never raise a collision; hidden from the default view.
fn is_background(cwd: &str) -> bool {
    let c = cwd.to_ascii_lowercase();
    c.contains("claude-mem") || c.contains("observer") || c.contains("-mem-")
}

// Mission-control / orchestration lanes (command-deck, orchestrator, brainstorm).
// Multiple live sessions here is expected - never raise a collision; the UI
// renders these calmly instead of as an alarm.
fn is_mission_control(cwd: &str) -> bool {
    let c = cwd.to_ascii_lowercase();
    c.contains("command-deck")
        || c.contains("orchestrator")
        || c.contains("mission-control")
        || c.contains("brainstorm")
}

// Repo-mutating tool names - a session that called any of these is a 'build'
// session (actually editing files), as opposed to a passive orchestrator /
// research session that only reads. Only build sessions count toward collisions.
fn is_edit_tool(name: &str) -> bool {
    matches!(name, "Edit" | "Write" | "MultiEdit" | "NotebookEdit")
}

// ── Output shapes (camelCase → matches the TS contract in src/flightdeck/types.ts) ──
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionCard {
    owner: SessionOwner,
    activity: String,
    cwd: String,
    id: String,
    title: Option<String>,
    status: String, // "live" | "recent" | "dormant"
    age_ms: u64,
    mtime: u64,
    model: Option<String>,
    model_label: Option<String>,
    effort: Option<String>,
    preview: Option<String>,
    branch: Option<String>,
    /// The session is OPEN - a live OS process, i.e. it is in Claude Code's left
    /// sidebar right now. This is NOT "a prompt is running": a window left open at
    /// an empty prompt is `running` all day. See `working`.
    running: bool,
    /// A prompt is ACTUALLY EXECUTING right now - the assistant is generating, or
    /// a tool it asked for is running. This is the ONLY thing that should make an
    /// agent orbit the brain. Derived from the transcript's last turn record, not
    /// from process liveness and not from file mtime (both of which stay "hot"
    /// while a session merely sits open).
    working: bool,
    /// Drives the deck's YOURS badge, the agent columns, the PRAXIS filter, and the wire style -
    /// all of which read "manual" for everything before this existed.
    origin: String,
    /// OS pid of the live process, straight from Claude's own session registry
    /// (`~/.claude/sessions/*.json`, liveness-checked). Carried so the deck's STOP
    /// control is reachable for a session the owner started BY HAND, not only for one
    /// Praxis spawned - by-hand is the case he actually tries first. None when the
    /// session is not running, or for drivers with no pid registry (codex/cursor).
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    role: String, // "build" (has edited repo files) | "passive" (orchestrator / research)
    // Trailing UN-answered tool request near EOF (a real approval gate the operator
    // must clear). Only ever set for a RUNNING + recent session - a headless
    // skip-permissions session never sits here (its tool auto-resolves), so this is
    // The owner's own interactive session waiting on a permission prompt. None otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    wants: Option<String>,
}

/// Per-lane git divergence vs the repo's integration branch - REAL `git diff
/// --numstat` totals plus commits ahead. Cached ~30s (see `lane_diff`).
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LaneDiff {
    added: u32,   // total inserted lines across changed files
    deleted: u32, // total deleted lines
    files: u32,   // number of files touched
    ahead: u32,   // commits on this lane's HEAD not yet in the base branch
    /// Files with UNCOMMITTED changes right now (`git status --porcelain`).
    /// The deck printed an unconditional "MAIN CLEAN" before this existed - a
    /// repo with 40 uncommitted files on main still read CLEAN.
    dirty_files: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Lane {
    id: String,           // encode_cwd(path) (stable; matches ~/.claude/projects + vault keys)
    label: String,        // lane role/name (e.g. "Integration", "Lane A", "Cursor")
    path: Option<String>, // worktree path; None for a remote/cloud lane
    branch: Option<String>,
    head: Option<String>,
    driver: String, // "integration" | "max" | "cursor" | "codex" | "cloud" | "claude"
    port: Option<u32>,
    kind: String,         // "worktree" | "cloud" | "mission-control"
    is_integration: bool, // the merge target other lanes flow into
    remote: bool,         // off-machine lane (cloud) - no local sessions
    read_only: bool,
    auto_read_only: bool,
    user_read_only: bool,
    background: bool,
    live_count: u32,         // running now
    recent_count: u32,       // active < 30 min, not running
    archived_count: u32,     // archived sessions rooted in this lane
    live_builder_count: u32, // running sessions actually editing files
    collision: bool,         // 2+ live build sessions in THIS working dir
    sessions: Vec<SessionCard>,
    overflow: u32, // additional non-archived sessions not shown
    // Real +adds/−dels/files/ahead this worktree diverges by vs the repo's base
    // branch (git numstat + rev-list). None for cloud/codex/cursor lanes (no local
    // worktree diff) or when git can't resolve a merge-base.
    #[serde(skip_serializing_if = "Option::is_none")]
    diff: Option<LaneDiff>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    id: String,    // normalized main-worktree path (stable repo identity)
    label: String, // pretty repo name (e.g. "Catalyzed Alpha")
    root: String,  // main worktree path
    lane_count: u32,
    running_lane_count: u32, // lanes with a live session right now
    active_lane_count: u32,  // lanes with a live OR recent session
    live_count: u32,
    recent_count: u32,
    archived_count: u32,
    collision: bool, // any lane in a real same-dir collision
    parallel: bool,  // 2+ lanes running at once, no collision → healthy parallelism
    has_fleet: bool, // more than one lane (a real worktree fleet)
    lanes: Vec<Lane>,
}

/// One Claude account whose unarchived sessions were kept off the deck, with how
/// many. Email comes from the Praxis ledger; `"unknown account"` when unmapped.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HiddenAccount {
    email: String,
    count: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    generated_at: u64,
    projects_dir: String,
    repos: Vec<Repo>,
    groups: Vec<SessionGroup>,
    /// The active window this snapshot was built with, in ms (0 = no time filter).
    /// The deck renders it as the current setting of its own window control.
    active_window_ms: u64,
    /// Unarchived sessions on a current account that fell OUTSIDE the window.
    /// Surfaced in the deck so the filter is visible, never silent.
    hidden_older: u32,
    /// Equals the sum of `hidden_accounts[].count` (kept for older clients).
    hidden_other_account: u32,
    /// Per-email breakdown of Claude sessions kept off the deck by the account rule.
    hidden_accounts: Vec<HiddenAccount>,
    /// Subagent rollouts excluded from the deck.
    hidden_subagents: u32,
    /// Sessions in verification and isolated agent-home folders.
    hidden_probes: u32,
    hidden_praxis: u32,
    hidden_automation: u32,
    hidden_placeholders: u32,
    active_count: u32,
    running_count: u32,
    /// Every operator lane lock currently set, by lane id. The snapshot's own lanes
    /// already carry `user_read_only`, but a lane that exists ONLY in the topology
    /// scan (a repo with no live sessions) is not among them - so locking one had
    /// no way to come back and the chip silently reverted on reload.
    read_only_lanes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ── A parsed session-manager record ──────────────────────────────────────────
/// Ownership is independent of launch attribution and process liveness.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum SessionOwner {
    Zach,
    Praxis,
    Automation,
    Subagent,
    Probe,
    Placeholder,
}

fn codex_owner(meta: &Value) -> SessionOwner {
    if meta.get("source").and_then(|s| s.get("subagent")).is_some() {
        SessionOwner::Subagent
    } else if meta.get("thread_source").and_then(Value::as_str) == Some("automation") {
        SessionOwner::Automation
    } else if meta.get("originator").and_then(Value::as_str) == Some("codex_exec") {
        SessionOwner::Praxis
    } else {
        SessionOwner::Zach
    }
}

fn cursor_owner(bubbles: usize) -> SessionOwner {
    if bubbles == 0 {
        SessionOwner::Placeholder
    } else {
        SessionOwner::Zach
    }
}

fn path_contains(root: &str, path: &str) -> bool {
    let root = norm_path(root);
    let path = norm_path(path);
    path == root || path.starts_with(&format!("{root}/"))
}

struct OwnerPaths {
    builds: String,
    verify: String,
    agent_home: String,
}
impl OwnerPaths {
    fn new(home: &str, local: &str) -> Self {
        Self {
            builds: format!("{home}/praxis-builds"),
            verify: format!("{home}/tools/praxis-verify"),
            agent_home: format!("{local}/Praxis/agent-home"),
        }
    }
}

fn classify_owner(owner: SessionOwner, cwd: &str, paths: &OwnerPaths) -> SessionOwner {
    // Structural non-sessions never become visible workers because of their cwd.
    if matches!(owner, SessionOwner::Placeholder | SessionOwner::Subagent) {
        return owner;
    }
    if path_contains(&paths.verify, cwd) || path_contains(&paths.agent_home, cwd) {
        SessionOwner::Probe
    } else if path_contains(&paths.builds, cwd) || path_contains("C:/Windows", cwd) {
        SessionOwner::Praxis
    } else {
        owner
    }
}

#[derive(Default, Debug, PartialEq, Eq)]
struct HiddenCounts {
    older: u32,
    praxis: u32,
    automation: u32,
    subagents: u32,
    probes: u32,
    placeholders: u32,
}

fn session_visible(card: &SessionCard, window: u64, hidden: &mut HiddenCounts) -> bool {
    let counter = match card.owner {
        SessionOwner::Subagent => Some(&mut hidden.subagents),
        SessionOwner::Probe => Some(&mut hidden.probes),
        SessionOwner::Placeholder => Some(&mut hidden.placeholders),
        SessionOwner::Praxis if !card.working => Some(&mut hidden.praxis),
        SessionOwner::Automation if !card.working => Some(&mut hidden.automation),
        SessionOwner::Zach
            if (card.id.starts_with("codex:") || card.id.starts_with("cursor:"))
                && window != 0
                && card.age_ms > window
                && !card.working =>
        {
            Some(&mut hidden.older)
        }
        _ => None,
    };
    if let Some(n) = counter {
        *n += 1;
        false
    } else {
        true
    }
}

/// Non-project sessions have two fixed containers, never pretend worktrees.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionGroup {
    id: String,
    label: String,
    root: String,
    sessions: Vec<SessionCard>,
}

struct RoutedSessions {
    accum: HashMap<String, RepoAccum>,
    groups: Vec<SessionGroup>,
    hidden: HiddenCounts,
    active_count: u32,
    running_count: u32,
}

/// Resolve both git's canonical paths and a Desktop junction spelling to the
/// same real lane; no extra lane is invented for the alias.
fn project_lane<'a>(
    projects: &'a [RepoInfo],
    cwd: &str,
) -> Option<(&'a RepoInfo, &'a WorktreeInfo)> {
    projects
        .iter()
        .flat_map(|p| {
            p.worktrees
                .iter()
                .enumerate()
                .map(move |(i, wt)| (p, i, wt))
        })
        .filter_map(|(p, i, wt)| {
            let direct = path_contains(&wt.path, cwd).then(|| norm_path(&wt.path).len());
            let alias = if i == 0 {
                p.root_alias
                    .as_ref()
                    .filter(|a| path_contains(a, cwd))
                    .map(|a| norm_path(a).len())
            } else {
                None
            };
            direct
                .into_iter()
                .chain(alias)
                .max()
                .map(|len| (p, wt, len))
        })
        .max_by_key(|(_, _, len)| *len)
        .map(|(p, wt, _)| (p, wt))
}

/// Pure policy boundary: injected facts only; no disk, clocks, git or globals.
fn route_sessions(
    cards: Vec<SessionCard>,
    projects: &[RepoInfo],
    paths: &OwnerPaths,
    window: u64,
) -> RoutedSessions {
    let mut result = RoutedSessions {
        accum: HashMap::new(),
        groups: vec![],
        hidden: HiddenCounts::default(),
        active_count: 0,
        running_count: 0,
    };
    for mut card in cards {
        card.owner = classify_owner(card.owner, &card.cwd, paths);
        card.working = card.running && card.working && card.age_ms < WORKING_STALE_MS;
        card.activity = if card.working { "running" } else { "active" }.into();
        if !session_visible(&card, window, &mut result.hidden) {
            continue;
        }
        if card.owner == SessionOwner::Zach {
            if card.working {
                result.running_count += 1;
            } else {
                result.active_count += 1;
            }
        }
        let target = if card.owner == SessionOwner::Praxis {
            None
        } else {
            project_lane(projects, &card.cwd)
        };
        if let Some((project, wt)) = target {
            let ra = result
                .accum
                .entry(project.key.clone())
                .or_insert_with(|| RepoAccum {
                    info: project.clone(),
                    bundles: HashMap::new(),
                    archived: HashMap::new(),
                });
            let b = ra
                .bundles
                .entry(norm_path(&wt.path))
                .or_insert_with(|| LaneBundle {
                    cards: vec![],
                    live_count: 0,
                    recent_count: 0,
                    live_builder_count: 0,
                    overflow: 0,
                });
            b.live_count += u32::from(card.working);
            b.recent_count += u32::from(!card.working);
            b.live_builder_count += u32::from(card.working && card.role == "build");
            b.cards.push(card);
        } else {
            let praxis = card.owner == SessionOwner::Praxis;
            let id = if praxis {
                "praxis-builds"
            } else {
                "other-folders"
            };
            let index = result
                .groups
                .iter()
                .position(|g| g.id == id)
                .unwrap_or_else(|| {
                    result.groups.push(SessionGroup {
                        id: id.into(),
                        label: if praxis {
                            "Praxis builds"
                        } else {
                            "Other folders"
                        }
                        .into(),
                        root: if praxis {
                            paths.builds.clone()
                        } else {
                            String::new()
                        },
                        sessions: vec![],
                    });
                    result.groups.len() - 1
                });
            result.groups[index].sessions.push(card);
        }
    }
    result.groups.sort_by(|a, b| a.id.cmp(&b.id));
    for group in &mut result.groups {
        group
            .sessions
            .sort_by(|a, b| b.mtime.cmp(&a.mtime).then(a.id.cmp(&b.id)));
    }
    for ra in result.accum.values_mut() {
        for b in ra.bundles.values_mut() {
            b.cards.sort_by(|a, b| {
                b.working
                    .cmp(&a.working)
                    .then(b.mtime.cmp(&a.mtime))
                    .then(a.id.cmp(&b.id))
            });
        }
    }
    result
}

fn project_registry_entry(path: PathBuf, desktop: &Path) -> Option<RepoInfo> {
    let mut info = git_resolve_repo(&path.to_string_lossy())?;
    info.root_alias = Some(path.to_string_lossy().into_owned());
    let name = basename(&path.to_string_lossy());
    let prefix = if name.eq_ignore_ascii_case("catalyzed-alpha") {
        "catalyzed"
    } else {
        &name
    };
    let lane_dir = desktop.join(format!("{prefix}-lanes"));
    if let Ok(lanes) = fs::read_dir(&lane_dir) {
        for lane in lanes.flatten() {
            let folder = lane.path();
            // Build caches and tool state (".target-bc", ".cargo-target") live beside
            // the lanes but are not lanes - measured 2026-09-24 as a phantom "LANE B".
            let hidden = folder
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with('.'));
            if !folder.is_dir() || hidden {
                continue;
            }
            let raw = folder.to_string_lossy().into_owned();
            if !info
                .worktrees
                .iter()
                .any(|w| norm_path(&w.path) == norm_path(&raw))
            {
                info.worktrees.push(WorktreeInfo {
                    path: raw,
                    branch: None,
                    head: None,
                });
            }
        }
    }
    info.worktrees[1..].sort_by_key(|w| norm_path(&w.path));
    info.specs = parse_lanes_manifest(&lane_dir);
    Some(info)
}

/// Runtime project registry shared by routing and topology; cached for one minute.
fn project_registry(refresh: bool) -> Vec<RepoInfo> {
    static CACHE: OnceLock<Mutex<Option<(u64, Vec<RepoInfo>)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let now = now_ms();
    if !refresh {
        if let Ok(c) = cache.lock() {
            if let Some((at, repos)) = c.as_ref() {
                if now.saturating_sub(*at) < 60_000 {
                    return repos.clone();
                }
            }
        }
    }
    let desktop = home_dir().join("Desktop");
    let candidates: Vec<PathBuf> = fs::read_dir(&desktop)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && path.join(".git").exists())
        .collect();
    // Every repo's git/worktree discovery is independent. Serial resolution made
    // this adapter alone cost ~3.5s; resolve the small Desktop repo set together.
    let mut repos = std::thread::scope(|scope| {
        let tasks: Vec<_> = candidates
            .into_iter()
            .map(|path| {
                let desktop = &desktop;
                scope.spawn(move || project_registry_entry(path, desktop))
            })
            .collect();
        tasks
            .into_iter()
            .filter_map(|task| task.join().ok().flatten())
            .collect::<Vec<_>>()
    });
    let mut seen = HashSet::new();
    repos.retain(|info| seen.insert(info.key.clone()));
    repos.sort_by_key(|p| {
        (
            if basename(&p.root).eq_ignore_ascii_case("praxis") {
                0
            } else {
                1
            },
            p.key.clone(),
        )
    });
    if let Ok(mut c) = cache.lock() {
        *c = Some((now, repos.clone()));
    }
    repos
}

pub(crate) fn project_topology() -> crate::flightdeck_topology::TopologySnapshot {
    use crate::flightdeck_topology::{TopologyRepo, TopologySnapshot, TopologyWorktree};
    TopologySnapshot {
        generated_at: now_ms(),
        repos: project_registry(true)
            .into_iter()
            .map(|p| TopologyRepo {
                id: p.key,
                label: p.label,
                root: p.root,
                worktrees: p
                    .worktrees
                    .into_iter()
                    .enumerate()
                    .map(|(i, w)| TopologyWorktree {
                        label: basename(&w.path),
                        path: w.path,
                        branch: w.branch,
                        head: w.head,
                        is_main: i == 0,
                    })
                    .collect(),
            })
            .collect(),
    }
}

/// Composer headers omit conversation content. Consult both Cursor DB schemas.
fn cursor_bubble_count(conn: &rusqlite::Connection, id: &str, header: &Value) -> usize {
    for table in ["cursorDiskKV", "ItemTable"] {
        let sql = format!("SELECT value FROM {table} WHERE key = ?1");
        let raw = conn.query_row(&sql, [format!("composerData:{id}")], |r| {
            let value = r.get_ref(0)?;
            Ok(match value {
                rusqlite::types::ValueRef::Text(b) | rusqlite::types::ValueRef::Blob(b) => {
                    String::from_utf8_lossy(b).into_owned()
                }
                _ => String::new(),
            })
        });
        if let Ok(raw) = raw {
            if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                return conversation_bubbles(&value);
            }
        }
    }
    conversation_bubbles(header)
}

fn conversation_bubbles(value: &Value) -> usize {
    value
        .get("fullConversationHeadersOnly")
        .or_else(|| value.get("conversation"))
        .and_then(Value::as_array)
        .map_or(0, Vec::len)
}

#[cfg(test)]
mod flightdeck_ownership_tests {
    use super::*;
    const DAY: u64 = 86_400_000;
    fn paths() -> OwnerPaths {
        OwnerPaths::new("C:/Users/dev", "C:/Users/dev/AppData/Local")
    }
    fn projects() -> Vec<RepoInfo> {
        vec![RepoInfo {
            root_alias: None,
            key: "praxis".into(),
            root: "C:/Users/dev/Desktop/praxis".into(),
            label: "Praxis".into(),
            specs: vec![],
            worktrees: vec![
                WorktreeInfo {
                    path: "C:/Users/dev/Desktop/praxis".into(),
                    branch: Some("main".into()),
                    head: None,
                },
                WorktreeInfo {
                    path: "C:/Users/dev/Desktop/praxis-lanes/lane-a".into(),
                    branch: None,
                    head: None,
                },
                WorktreeInfo {
                    path: "C:/Users/dev/Desktop/praxis/nested".into(),
                    branch: None,
                    head: None,
                },
            ],
        }]
    }
    fn card(id: &str, owner: SessionOwner, cwd: &str, age: u64, working: bool) -> SessionCard {
        SessionCard {
            id: id.into(),
            owner,
            cwd: cwd.into(),
            activity: String::new(),
            title: Some(id.into()),
            status: "recent".into(),
            age_ms: age,
            mtime: (40 * DAY).saturating_sub(age),
            model: None,
            model_label: None,
            effort: None,
            preview: None,
            branch: None,
            running: working,
            working,
            origin: "manual".into(),
            pid: None,
            role: "build".into(),
            wants: None,
        }
    }
    fn visible(r: &RoutedSessions) -> usize {
        r.accum
            .values()
            .flat_map(|a| a.bundles.values())
            .map(|b| b.cards.len())
            .sum::<usize>()
            + r.groups.iter().map(|g| g.sessions.len()).sum::<usize>()
    }

    #[test]
    fn thirty_days_do_not_accumulate_workers_placeholders_or_repos() {
        let projects = projects();
        let mut cards = vec![];
        for day in 1..=30 {
            // Yesterday's workers have finished; readers inject current turn facts.
            for c in &mut cards {
                let c: &mut SessionCard = c;
                c.age_ms += DAY;
                c.running = false;
                c.working = false;
            }
            let working = day % 5 == 0;
            let build = format!("C:/Users/dev/praxis-builds/day-{day}");
            cards.push(card(
                &format!("codex:exec-{day}"),
                codex_owner(&serde_json::json!({"originator":"codex_exec", "source":"exec"})),
                &build,
                0,
                working,
            ));
            cards.push(card(
                &format!("codex:auto-{day}"),
                codex_owner(&serde_json::json!({"thread_source":"automation"})),
                &projects[0].root,
                0,
                working,
            ));
            for mode in ["agent", "chat"] {
                cards.push(card(
                    &format!("cursor:{mode}-{day}"),
                    cursor_owner(0),
                    &build,
                    0,
                    false,
                ));
            }
            cards.push(card(
                &format!("codex:probe-{day}"),
                SessionOwner::Zach,
                &format!("C:/Users/dev/tools/praxis-verify/live-test/day-{day}"),
                0,
                true,
            ));
            cards.push(card(
                &format!("codex:child-{day}"),
                SessionOwner::Subagent,
                &projects[0].root,
                0,
                true,
            ));
            // Exercise both real projects and the single Other folders container.
            let cwd = if day % 2 == 0 {
                projects[0].root.clone()
            } else {
                format!("C:/scratch/day-{day}")
            };
            cards.push(card(
                &format!("codex:zach-{day}"),
                SessionOwner::Zach,
                &cwd,
                0,
                false,
            ));
            let r = route_sessions(cards.clone(), &projects, &paths(), 7 * DAY - 1);
            let zach = day.min(7);
            let workers = if working { 2 } else { 0 };
            assert_eq!(visible(&r), (zach + workers) as usize, "day {day}");
            assert!(r.accum.len() + r.groups.len() <= projects.len() + 2);
            assert_eq!(r.active_count, zach);
            assert_eq!(r.running_count, 0, "non-Zach work is never in his count");
            assert_eq!(
                r.hidden,
                HiddenCounts {
                    older: day - zach,
                    praxis: day - u32::from(working),
                    automation: day - u32::from(working),
                    placeholders: 2 * day,
                    probes: day,
                    subagents: day
                }
            );
            // A repeat refresh must not double any exclusion counts.
            assert_eq!(
                r.hidden,
                route_sessions(cards.clone(), &projects, &paths(), 7 * DAY - 1).hidden
            );
        }
    }

    #[test]
    fn cursor_conversations_are_visible_only_in_the_right_owner_state() {
        let p = projects();
        let cards = vec![
            card("cursor:real", cursor_owner(1), &p[0].root, 0, false),
            card(
                "cursor:build",
                cursor_owner(1),
                "C:/Users/dev/praxis-builds/build",
                0,
                false,
            ),
            card(
                "cursor:working",
                cursor_owner(2),
                "C:/Users/dev/praxis-builds/build-2",
                0,
                true,
            ),
        ];
        let r = route_sessions(cards, &p, &paths(), DAY);
        assert_eq!(visible(&r), 2);
        assert_eq!(r.hidden.praxis, 1);
        assert_eq!(r.groups.len(), 1);
        assert_eq!(r.groups[0].label, "Praxis builds");
        assert_eq!(r.groups[0].root, paths().builds);
        assert_eq!(r.groups[0].sessions[0].activity, "running");
    }

    #[test]
    fn owner_metadata_and_folder_boundaries_are_explicit() {
        assert_eq!(
            codex_owner(&serde_json::json!({"originator":"Codex Desktop","source":"vscode"})),
            SessionOwner::Zach
        );
        assert_eq!(
            codex_owner(&serde_json::json!({"source":{"subagent":{} }})),
            SessionOwner::Subagent
        );
        assert_eq!(
            codex_owner(&serde_json::json!({"thread_source":"automation"})),
            SessionOwner::Automation
        );
        for owner in [
            SessionOwner::Zach,
            SessionOwner::Praxis,
            SessionOwner::Automation,
        ] {
            for path in [
                "c:\\USERS\\dev\\tools\\praxis-verify\\test",
                "C:/Users/dev/AppData/Local/Praxis/agent-home/one",
            ] {
                assert_eq!(classify_owner(owner, path, &paths()), SessionOwner::Probe);
            }
            assert_eq!(
                classify_owner(owner, "c:\\WINDOWS\\System32", &paths()),
                SessionOwner::Praxis
            );
            assert_eq!(
                classify_owner(owner, "C:/Users/dev/praxis-builds/a", &paths()),
                SessionOwner::Praxis
            );
        }
        for path in [
            "C:/Windows-old",
            "C:/Users/dev/praxis-builds-old",
            "C:/Users/dev/tools/praxis-verify-more",
        ] {
            assert_eq!(
                classify_owner(SessionOwner::Zach, path, &paths()),
                SessionOwner::Zach
            );
        }
        assert_eq!(
            classify_owner(SessionOwner::Placeholder, &paths().builds, &paths()),
            SessionOwner::Placeholder
        );
    }

    #[test]
    fn nested_and_unregistered_lane_folders_use_longest_prefix_without_overwriting_cards() {
        let p = projects();
        let r = route_sessions(
            vec![
                card(
                    "claude-1",
                    SessionOwner::Zach,
                    "C:/Users/dev/Desktop/praxis/nested/src",
                    50 * DAY,
                    false,
                ),
                card(
                    "codex:2",
                    SessionOwner::Zach,
                    "C:/Users/dev/Desktop/praxis/nested/other",
                    0,
                    true,
                ),
                card(
                    "cursor:3",
                    SessionOwner::Zach,
                    "C:/Users/dev/Desktop/praxis-lanes/lane-a/src",
                    0,
                    false,
                ),
                card(
                    "codex:4",
                    SessionOwner::Zach,
                    "C:/Users/dev/Desktop/praxis-other",
                    0,
                    false,
                ),
            ],
            &p,
            &paths(),
            DAY,
        );
        let bundles = &r.accum["praxis"].bundles;
        assert_eq!(
            bundles[&norm_path("C:/Users/dev/Desktop/praxis/nested")]
                .cards
                .len(),
            2
        );
        assert_eq!(
            bundles[&norm_path("C:/Users/dev/Desktop/praxis-lanes/lane-a")]
                .cards
                .len(),
            1
        );
        assert_eq!(r.groups[0].label, "Other folders");
        assert_eq!((r.active_count, r.running_count), (3, 1));
    }

    #[test]
    fn desktop_junction_alias_attaches_to_the_same_main_lane() {
        let mut p = projects();
        p[0].root_alias = Some("D:/Desktop/Praxis".into());
        let r = route_sessions(
            vec![card(
                "codex:alias",
                SessionOwner::Zach,
                "d:\\desktop\\PRAXIS\\src",
                0,
                false,
            )],
            &p,
            &paths(),
            DAY,
        );
        assert!(r.groups.is_empty());
        assert_eq!(
            r.accum["praxis"].bundles[&norm_path(&p[0].root)]
                .cards
                .len(),
            1
        );
        assert_eq!(r.accum["praxis"].info.worktrees.len(), p[0].worktrees.len());
    }

    #[test]
    fn working_requires_process_open_turn_and_freshness() {
        let mut no_process = card(
            "codex:no-process",
            SessionOwner::Praxis,
            "C:/scratch",
            0,
            true,
        );
        no_process.running = false;
        let mut open_idle = card("codex:idle", SessionOwner::Praxis, "C:/scratch", 0, false);
        open_idle.running = true;
        let r = route_sessions(
            vec![
                no_process,
                open_idle,
                card(
                    "codex:stale",
                    SessionOwner::Praxis,
                    "C:/scratch",
                    WORKING_STALE_MS,
                    true,
                ),
                card(
                    "codex:fresh",
                    SessionOwner::Praxis,
                    "C:/scratch",
                    WORKING_STALE_MS - 1,
                    true,
                ),
            ],
            &[],
            &paths(),
            0,
        );
        assert_eq!(visible(&r), 1);
        assert_eq!(r.hidden.praxis, 3);
    }

    #[test]
    fn composer_data_not_draft_flags_decides_placeholder_for_both_schemas() {
        for table in ["cursorDiskKV", "ItemTable"] {
            let conn = rusqlite::Connection::open_in_memory().unwrap();
            conn.execute(&format!("CREATE TABLE {table} (key TEXT, value BLOB)"), [])
                .unwrap();
            for (id, data, count) in [
                ("empty", r#"{"fullConversationHeadersOnly":[]}"#, 0),
                (
                    "real",
                    r#"{"fullConversationHeadersOnly":[{"bubbleId":"one"}]}"#,
                    1,
                ),
            ] {
                conn.execute(
                    &format!("INSERT INTO {table} VALUES (?1, ?2)"),
                    rusqlite::params![format!("composerData:{id}"), data.as_bytes()],
                )
                .unwrap();
                assert_eq!(
                    cursor_bubble_count(
                        &conn,
                        id,
                        &serde_json::json!({"name":null,"isDraft":false})
                    ),
                    count
                );
            }
        }
    }
}

struct Record {
    cli_session_id: String,
    cwd: String,
    title: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    is_archived: bool,
    last_activity_at: u64,
    /// `<accountUuid>/<organizationUuid>` - the store subdirectory this record was read from.
    account: String,
}

// ── Paths / env (Windows-first, but degrades gracefully elsewhere) ────────────
fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn projects_dir() -> PathBuf {
    home_dir().join(".claude").join("projects")
}

fn sessions_registry_dir() -> PathBuf {
    home_dir().join(".claude").join("sessions")
}

fn session_store_dir() -> Option<PathBuf> {
    // Windows: %APPDATA%/Claude/claude-code-sessions. Elsewhere best-effort.
    if let Ok(appdata) = std::env::var("APPDATA") {
        return Some(
            PathBuf::from(appdata)
                .join("Claude")
                .join("claude-code-sessions"),
        );
    }
    let h = home_dir();
    for c in [
        h.join("Library/Application Support/Claude/claude-code-sessions"),
        h.join(".config/Claude/claude-code-sessions"),
    ] {
        if c.is_dir() {
            return Some(c);
        }
    }
    None
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn mtime_ms(p: &Path) -> Option<u64> {
    let md = fs::metadata(p).ok()?;
    let m = md.modified().ok()?;
    m.duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// Replicate the ~/.claude/projects folder-name encoding for a cwd:
///   "C:\Users\me\Desktop\app" → "C--Users-me-Desktop-app"
fn encode_cwd(cwd: &str) -> String {
    let mut s: String = cwd
        .chars()
        .map(|c| match c {
            ':' => '\u{0}', // strip (placeholder removed below)
            '\\' | '/' => '-',
            _ => c,
        })
        .filter(|c| *c != '\u{0}')
        .collect();
    // drive letter "C-Users…" → "C--Users…"
    let bytes: Vec<char> = s.chars().collect();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == '-' {
        s = format!("{}-{}", bytes[0], &s[1..]);
    }
    s
}

/// Compare-friendly path key: forward slashes, no trailing slash, lowercased.
fn norm_path(p: &str) -> String {
    p.replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

/// Last path component (the folder name).
fn basename(p: &str) -> String {
    p.trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(p)
        .to_string()
}

/// Parent directory of a path (forward-slashed, no trailing slash).
fn parent_dir(p: &str) -> String {
    let t = p.replace('\\', "/");
    let t = t.trim_end_matches('/');
    match t.rfind('/') {
        Some(i) => t[..i].to_string(),
        None => String::new(),
    }
}

/// Longest common ancestor directory of a set of paths (case-insensitive).
fn common_dir(paths: &[String]) -> Option<String> {
    if paths.is_empty() {
        return None;
    }
    let split = |s: &str| -> Vec<String> {
        s.replace('\\', "/")
            .trim_end_matches('/')
            .split('/')
            .map(|x| x.to_string())
            .collect()
    };
    let mut common = split(&paths[0]);
    for p in &paths[1..] {
        let parts = split(p);
        let mut n = 0;
        while n < common.len() && n < parts.len() && common[n].eq_ignore_ascii_case(&parts[n]) {
            n += 1;
        }
        common.truncate(n);
    }
    if common.is_empty() {
        None
    } else {
        Some(common.join("/"))
    }
}

fn liveness(age_ms: u64) -> &'static str {
    if age_ms < LIVE_MS {
        "live"
    } else if age_ms < RECENT_MS {
        "recent"
    } else {
        "dormant"
    }
}

fn pretty_model(id: &str) -> Option<String> {
    if id.is_empty() || (id.starts_with('<') && id.ends_with('>')) {
        return None;
    }
    let map: &[(&str, &str)] = &[
        ("opus-4-8", "Opus 4.8"),
        ("opus-4-7", "Opus 4.7"),
        ("opus-4-6", "Opus 4.6"),
        ("opus-4-1", "Opus 4.1"),
        ("opus", "Opus"),
        ("sonnet-4-6", "Sonnet 4.6"),
        ("sonnet-4-5", "Sonnet 4.5"),
        ("sonnet", "Sonnet"),
        ("haiku-4-5", "Haiku 4.5"),
        ("haiku", "Haiku"),
        ("fable-5", "Fable 5"),
        ("fable", "Fable"),
    ];
    for (re, label) in map {
        if id.contains(re) {
            return Some((*label).to_string());
        }
    }
    Some(id.to_string())
}

fn clean(text: &str) -> Option<String> {
    // Pick the first meaningful line - skip blank lines and XML/HTML-ish tag
    // scaffolding (a line starting with '<', e.g. "<recommended_plugins>") so raw
    // transcript noise never becomes a preview or, via the title fallback, a card
    // name. Whitespace within that line is collapsed and the result capped.
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('<'))?;
    let s: String = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() {
        return None;
    }
    if s.chars().count() > PREVIEW_MAX {
        let truncated: String = s.chars().take(PREVIEW_MAX - 1).collect();
        Some(format!("{}…", truncated.trim_end()))
    } else {
        Some(s)
    }
}

fn pretty_label(cwd: &str) -> String {
    let base = basename(cwd);
    // "catalyzed-alpha" → "Catalyzed Alpha"
    base.split(['-', '_'])
        .filter(|s| !s.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ── Read the session-manager store (recursively) ─────────────────────────────
fn walk_json(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 6 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_json(&p, out, depth + 1);
        } else if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
            if name.starts_with("local_") && name.ends_with(".json") {
                out.push(p);
            }
        }
    }
}

/// `<accountUuid>/<organizationUuid>` for a store file, derived from its path
/// relative to the store root (`claude-code-sessions/<acct>/<org>/local_*.json`).
/// Empty when the layout is anything else - callers treat "" as always-current so
/// an unexpected layout can never blank the deck.
fn account_key_of(store: &Path, file: &Path) -> String {
    let Ok(rel) = file.strip_prefix(store) else {
        return String::new();
    };
    let parts: Vec<&str> = rel
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();
    if parts.len() >= 3 {
        format!("{}/{}", parts[0], parts[1])
    } else {
        String::new()
    }
}

fn signed_in_account_key() -> Option<String> {
    let (key, _email) = signed_in_account()?;
    Some(key)
}

fn signed_in_account() -> Option<(String, String)> {
    let raw = fs::read_to_string(home_dir().join(".claude.json")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let acct = v.pointer("/oauthAccount/accountUuid")?.as_str()?;
    let org = v.pointer("/oauthAccount/organizationUuid")?.as_str()?;
    let email = v
        .pointer("/oauthAccount/emailAddress")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    Some((format!("{acct}/{org}"), email))
}

/// Claude sessions on the owner's deck - account rule (2026-10-04, replaces 2026-09-14):
///
/// Unknown / empty store keys stay admitted (unexpected layout must never blank the deck).
/// Everything else (e.g. another signed-in account) is hidden and counted in
/// `hidden_accounts`. Codex and Cursor are not filtered by Claude account.
const ALLOWED_ACCOUNT_LOCALPARTS: [&str; 1] = ["deckowner"];

fn email_is_allowed(email: &str) -> bool {
    let email = email.trim().to_ascii_lowercase();
    let (local, domain) = match email.split_once('@') {
        Some((l, d)) => (l, d),
        None => (email.as_str(), ""),
    };
    ALLOWED_ACCOUNT_LOCALPARTS.contains(&local) && (domain.is_empty() || domain == "example.com")
}

fn account_ledger_path() -> Option<PathBuf> {
    crate::praxis_dir().map(|d| d.join("claude-accounts.json"))
}

/// Remember which store key belongs to which email.
///
/// ─────────────────────────────────────────────────────────────────────────────
/// WHY A LEDGER AND NOT A LOOKUP.
///
/// The session store is keyed `<accountUuid>/<organizationUuid>` and carries no email anywhere.
///
/// This records the pairing each time it sees one, which is the only way the mapping can exist
/// at all. It is additive and never forgets, so switching back and forth builds the set rather
/// than replacing it.
/// ─────────────────────────────────────────────────────────────────────────────
fn remember_signed_in_account() {
    let Some((key, email)) = signed_in_account() else {
        return;
    };
    if email.is_empty() {
        return;
    }
    let Some(path) = account_ledger_path() else {
        return;
    };
    let mut map: std::collections::BTreeMap<String, String> = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if map.get(&key).map(String::as_str) == Some(email.as_str()) {
        return; // already recorded - do not rewrite the file on every poll
    }
    map.insert(key, email);
    if let Ok(body) = serde_json::to_string_pretty(&map) {
        let _ = fs::write(&path, body);
    }
}

/// Store keys we have seen belong to an allowed email.
fn remembered_allowed_keys() -> HashSet<String> {
    let mut out = HashSet::new();
    let ledger = read_account_ledger();
    let allowed_uuids: HashSet<String> = ledger
        .iter()
        .filter(|(_, email)| email_is_allowed(email))
        .filter_map(|(key, _)| key.split('/').next().map(|s| s.to_string()))
        .collect();
    for (key, email) in &ledger {
        if email_is_allowed(email) {
            out.insert(key.clone());
        }
        // Also keep the bare uuid so callers can match by account alone.
        if let Some(uuid) = key.split('/').next() {
            if allowed_uuids.contains(uuid) {
                out.insert(uuid.to_string());
            }
        }
    }
    for uuid in allowed_uuids {
        out.insert(uuid);
    }
    out
}

/// Resolve a store key to a display email for `hidden_accounts`.
fn email_for_account_key(key: &str, ledger: &std::collections::BTreeMap<String, String>) -> String {
    if let Some(e) = ledger.get(key) {
        let t = e.trim();
        return if t.is_empty() {
            "unknown account".to_string()
        } else {
            t.to_ascii_lowercase()
        };
    }
    let uuid = key.split('/').next().unwrap_or("");
    if !uuid.is_empty() {
        for (k, e) in ledger {
            if k.split('/').next() == Some(uuid) {
                let t = e.trim();
                if !t.is_empty() {
                    return t.to_ascii_lowercase();
                }
            }
        }
    }
    "unknown account".to_string()
}

/// This is deliberately STRICT - an earlier version also admitted any account with activity in
/// the last 14 days, on the theory that a desktop account and a CLI account could both be live.
/// Claude Code's own sidebar shows exactly one account's sessions, so this does too. Switching
/// accounts switches the deck with it, on the next poll, with no archiving required.
///
/// The empty key is always admitted so an unrecognised store layout degrades to "show it" rather
/// than blanking the deck.
///
/// ─────────────────────────────────────────────────────────────────────────────
/// THE DECK WAS READING THE WRONG APP'S ACCOUNT.
///
/// Measured 2026-09-13:
///
/// Praxis only ever learned account emails from `~/.claude.json`, so its real
/// ledger held one entry (00000001 -> main) and never learned 00000000 at all. Every
/// session in his actual sidebar - including the one open while this was written -
/// was filtered off the deck as "another account". The deck showed two stale cards
/// from the CLI's account instead.
///
/// That is the authoritative answer to "whose sidebar", with no email lookup required.
/// ─────────────────────────────────────────────────────────────────────────────
fn desktop_account_uuid() -> Option<String> {
    let appdata = std::env::var("APPDATA").ok()?;
    let raw = fs::read_to_string(PathBuf::from(appdata).join("Claude").join("config.json")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let id = v.get("lastKnownAccountUuid")?.as_str()?.trim().to_string();
    (!id.is_empty()).then_some(id)
}

/// Every store key the ledger has paired with an email (allowed or not).
fn read_account_ledger() -> std::collections::BTreeMap<String, String> {
    account_ledger_path()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Which store keys belong to the desktop app's account. Pure, so the rule is
/// testable without a real store.
pub(crate) fn desktop_account_keys<'a>(
    record_accounts: impl Iterator<Item = &'a str>,
    desktop_uuid: Option<&str>,
    _ledger: &std::collections::BTreeMap<String, String>,
) -> HashSet<String> {
    let mut out = HashSet::new();
    let Some(uuid) = desktop_uuid.filter(|u| !u.is_empty()) else {
        return out;
    };
    for acct in record_accounts {
        if acct.split('/').next() == Some(uuid) {
            out.insert(acct.to_string());
        }
    }
    out
}

fn admit_account_uuid(
    keys: &mut HashSet<String>,
    uuid: &str,
    recs: &[Record],
    ledger: &std::collections::BTreeMap<String, String>,
) {
    if uuid.is_empty() {
        return;
    }
    for r in recs {
        if r.account.split('/').next() == Some(uuid) {
            keys.insert(r.account.clone());
        }
    }
    for key in ledger.keys() {
        if key.split('/').next() == Some(uuid) {
            keys.insert(key.clone());
        }
    }
}

/// `window == 0` means "All".
fn claude_record_outside_window(
    r: &Record,
    signed_in_uuids: &HashSet<String>,
    window: u64,
    now: u64,
    running: &HashMap<String, u32>,
) -> bool {
    let uuid = r.account.split('/').next().unwrap_or("");
    if uuid.is_empty() || signed_in_uuids.is_empty() || signed_in_uuids.contains(uuid) {
        return false;
    }
    if window == 0 || running.contains_key(&r.cli_session_id) {
        return false;
    }
    now.saturating_sub(r.last_activity_at) > window
}

fn current_account_keys(recs: &[Record], _now: u64) -> HashSet<String> {
    remember_signed_in_account();

    let ledger = read_account_ledger();
    let mut keys: HashSet<String> = HashSet::new();
    keys.insert(String::new()); // unknown layout → never filtered out

    // Allowlisted accounts: admit every org under those account UUIDs.
    let allowed_uuids: HashSet<String> = ledger
        .iter()
        .filter(|(_, email)| email_is_allowed(email))
        .filter_map(|(key, _)| key.split('/').next().map(|s| s.to_string()))
        .collect();
    for uuid in &allowed_uuids {
        admit_account_uuid(&mut keys, uuid, recs, &ledger);
    }
    for (key, email) in &ledger {
        if email_is_allowed(email) {
            keys.insert(key.clone());
        }
    }

    keys.extend(desktop_account_keys(
        recs.iter().map(|r| r.account.as_str()),
        desktop_account_uuid().as_deref(),
        &ledger,
    ));

    if let Some((key, _email)) = signed_in_account() {
        keys.insert(key.clone());
        if let Some(uuid) = key.split('/').next() {
            admit_account_uuid(&mut keys, uuid, recs, &ledger);
        }
    }
    keys
}

/// The live active window, in ms. Process-global so `build_snapshot_with` - which
/// is called from threads with no `AppHandle` - can read it without plumbing.
/// Seeded from the vault at startup and on every `fd_sessions` poll.
/// How many codex/cursor sessions the ACTIVE WINDOW dropped during the last
/// snapshot build. Reported to the deck as `hiddenOlder` so the filter is visible
/// rather than a silent truncation - the scans that do the dropping are several
/// call frames away from the snapshot assembly, so they report through here.
///
static ACTIVE_WINDOW: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(DEFAULT_ACTIVE_WINDOW_MS);

pub(crate) fn active_window_ms() -> u64 {
    ACTIVE_WINDOW.load(std::sync::atomic::Ordering::Relaxed)
}

/// Window helper for reader diagnostics; `running` means a live turn, not an open app.
fn within_active_window(age_ms: u64, running: bool) -> bool {
    if running {
        return true;
    }
    let w = active_window_ms();
    w == ACTIVE_WINDOW_ALL || age_ms <= w
}

fn read_records() -> Vec<Record> {
    let Some(store) = session_store_dir() else {
        return vec![];
    };
    let mut files = vec![];
    walk_json(&store, &mut files, 0);
    // A session can have MULTIPLE local_*.json records (the store nests + rewrites). Keep only
    // the MOST RECENT per cliSessionId - its `isArchived` is the CURRENT state. Without this,
    // archiving a session leaves an older duplicate record (still isArchived:false) behind, so
    // the archived session leaks back onto the deck. Dedup by id, max lastActivityAt wins.
    let mut by_id: HashMap<String, Record> = HashMap::new();
    for f in files {
        let Ok(raw) = fs::read_to_string(&f) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let cli = v.get("cliSessionId").and_then(|x| x.as_str());
        let cwd = v.get("cwd").and_then(|x| x.as_str());
        let (Some(cli), Some(cwd)) = (cli, cwd) else {
            continue;
        };
        let rec = Record {
            cli_session_id: cli.to_string(),
            cwd: cwd.to_string(),
            title: v
                .get("title")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from),
            model: v.get("model").and_then(|x| x.as_str()).map(String::from),
            effort: v.get("effort").and_then(|x| x.as_str()).map(String::from),
            is_archived: v
                .get("isArchived")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
            last_activity_at: v
                .get("lastActivityAt")
                .and_then(|x| x.as_u64())
                .unwrap_or(0),
            account: account_key_of(&store, &f),
        };
        match by_id.get(&rec.cli_session_id) {
            // keep the newest record; on a tie, let an archived state win (don't resurrect)
            Some(prev)
                if prev.last_activity_at > rec.last_activity_at
                    || (prev.last_activity_at == rec.last_activity_at && prev.is_archived) => {}
            _ => {
                by_id.insert(rec.cli_session_id.clone(), rec);
            }
        }
    }
    by_id.into_values().collect()
}

/// PIDs of alive Claude Code session processes. A session launched from the
/// desktop app runs as `claude.exe`; some CLI / SDK entrypoints run as
/// `node.exe`. We MUST accept BOTH image names - filtering to `node.exe` alone
/// silently missed every desktop-app session (the common case), so running
/// detection returned nothing and any open-but-idle session vanished from the
/// deck (the "missing session" bug). Matching the image name (rather than any
/// pid) still guards against a recorded pid being recycled by an unrelated
/// process after the session exited.
fn alive_session_pids() -> HashSet<u32> {
    let mut pids = HashSet::new();
    #[cfg(windows)]
    {
        for image in ["claude.exe", "node.exe"] {
            collect_pids_for_image(image, &mut pids);
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(out) = std::process::Command::new("ps")
            .args(["-eo", "pid=,comm="])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let mut it = line.trim().splitn(2, char::is_whitespace);
                if let (Some(pid_s), Some(comm)) = (it.next(), it.next()) {
                    if comm.contains("node") || comm.contains("claude") {
                        if let Ok(pid) = pid_s.trim().parse::<u32>() {
                            pids.insert(pid);
                        }
                    }
                }
            }
        }
    }
    pids
}

#[cfg(windows)]
fn collect_pids_for_image(image: &str, pids: &mut HashSet<u32>) {
    use std::os::windows::process::CommandExt;
    let filter = format!("IMAGENAME eq {image}");
    // CREATE_NO_WINDOW (0x08000000) - same as the git calls: no flashing console.
    let mut cmd = std::process::Command::new("tasklist");
    cmd.args(["/NH", "/FO", "CSV", "/FI", filter.as_str()])
        .creation_flags(0x0800_0000);
    if let Some(out) = output_with_timeout(cmd, PROCESS_PROBE_TIMEOUT) {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            // CSV row: "claude.exe","12345","Console","1","123,456 K"
            let cols: Vec<&str> = line.split("\",\"").collect();
            if cols.len() >= 2 {
                if let Ok(pid) = cols[1].trim_matches('"').trim().parse::<u32>() {
                    pids.insert(pid);
                }
            }
        }
    }
}

/// Session ids (cliSessionId) whose registered process is ACTUALLY alive right
/// now. The registry (`~/.claude/sessions/<pid>.json`) is written at session
/// START but is NOT reliably removed on exit, so a file's mere existence means
/// "was started", not "is running" - we MUST verify the pid is live, or sessions
/// that ended hours ago keep reading as running (the inflated RUNNING count bug).
/// session id → live OS pid, from Claude's own session registry. The pid was
/// already being read here to prove liveness and then thrown away, which is why
/// the deck's STOP control could never appear: it gates on a known pid, and the
/// only pids it knew were the ones Praxis had spawned itself this run.
fn running_pids() -> HashMap<String, u32> {
    let mut map = HashMap::new();
    let alive = alive_session_pids();
    let Ok(entries) = fs::read_dir(sessions_registry_dir()) else {
        return map;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                let pid = v.get("pid").and_then(|x| x.as_u64());
                let sid = v.get("sessionId").and_then(|x| x.as_str());
                if let (Some(pid), Some(sid)) = (pid, sid) {
                    // RUNNING only if the registered process is genuinely alive
                    if alive.contains(&(pid as u32)) {
                        map.insert(sid.to_string(), pid as u32);
                    }
                }
            }
        }
    }
    map
}

fn running_set() -> HashSet<String> {
    running_pids().into_keys().collect()
}

/// A live session with everything the push-based event bus needs: its id, the
/// working dir (→ brain area), its transcript path (to tail), and its model. This
/// is the single source of truth shared by `transcript_tailer` (tails the file)
/// and `session_poller` (diffs the running set) so neither has to re-derive the
/// ~/.claude/projects encoding or re-walk the session store on its own.
pub(crate) struct RunningSession {
    pub session_id: String,
    pub cwd: String,
    pub transcript: PathBuf,
    pub model: Option<String>,
}

/// All currently-running Claude sessions (process verified alive), each paired
/// with its on-disk transcript path and model. Deduped by session id - a session
/// can appear in more than one `local_*.json` store file; we keep the most recent
/// record so the model/cwd reflect the latest state. Background/observer lanes are
/// excluded (same rule the deck uses) so the brain never lights up for the mem
/// observer churning in the background.
pub(crate) fn running_sessions() -> Vec<RunningSession> {
    let running = running_set();
    if running.is_empty() {
        return vec![];
    }
    let proj = projects_dir();
    // session_id → (last_activity_at, Record-derived fields), newest wins.
    let mut best: HashMap<String, (u64, String, Option<String>)> = HashMap::new();
    for r in read_records() {
        if !running.contains(&r.cli_session_id) || is_background(&r.cwd) {
            continue;
        }
        let entry = best.entry(r.cli_session_id.clone());
        match entry {
            std::collections::hash_map::Entry::Occupied(mut o) => {
                if r.last_activity_at > o.get().0 {
                    *o.get_mut() = (r.last_activity_at, r.cwd, r.model);
                }
            }
            std::collections::hash_map::Entry::Vacant(v) => {
                v.insert((r.last_activity_at, r.cwd, r.model));
            }
        }
    }
    best.into_iter()
        .map(|(session_id, (_, cwd, model))| {
            let transcript = proj
                .join(encode_cwd(&cwd))
                .join(format!("{session_id}.jsonl"));
            RunningSession {
                session_id,
                cwd,
                transcript,
                model,
            }
        })
        .collect()
}

/// The subset of OPEN sessions where a prompt is ACTUALLY RUNNING right now.
///
/// `running_sessions()` above is every session with a live process - that is what
/// `transcript_tailer` needs, because it has to be watching an idle session to see
/// its next turn begin. But it is the wrong set for the brain: an open Claude Code
/// window with an empty prompt has a live pid all day, and emitting it as "started"
/// put an agent in orbit with nothing running (owner request 2026-09-05).
///
/// Same derivation the deck's cards use - the transcript's last turn record, with
/// a staleness cap so a wedged or killed-mid-turn session stands down.
pub(crate) fn working_sessions() -> Vec<RunningSession> {
    let now = now_ms();
    running_sessions()
        .into_iter()
        .filter(|s| {
            let tail = read_transcript_tail(&s.transcript);
            tail.turn_in_flight
                && tail.turn_ts > 0
                && now.saturating_sub(tail.turn_ts) < WORKING_STALE_MS
        })
        .collect()
}

// ── Transcript tail parse (preview + branch). Reads only the last 64KB. ────────
struct Tail {
    preview: Option<String>,
    branch: Option<String>,
    model: Option<String>,
    has_edits: bool, // session called a repo-mutating tool somewhere in the tail
    // A trailing tool_use the assistant STOPPED on (stop_reason == "tool_use") that
    // no later user/tool_result answers - i.e. the turn is parked on a tool request.
    // For a live interactive session this is an approval gate awaiting the operator.
    wants: Option<String>,
    /// Is a PROMPT ACTUALLY RUNNING right now?
    ///
    /// The transcript says which. Read the last TURN record (type user/assistant;
    /// see `turn_ts` for why everything else must be skipped):
    ///   • `user`      → the assistant is generating right now  → TURN IN FLIGHT
    ///                   (this covers a tool_result too - the turn continues)
    ///   • `assistant` stop_reason "tool_use" → it asked for a tool. Fresh means
    ///                   the tool is executing (in flight); stale means it is
    ///                   parked at an approval prompt waiting for the owner (see
    ///                   `wants`), which is waiting, NOT working.
    ///   • `assistant` end_turn → it answered and is waiting for input → IDLE.
    turn_in_flight: bool,
    /// Timestamp of the last real TURN record, ms. NOT the file mtime: a live
    /// session writes hundreds of `attachment` / `queue-operation` / `atis-latch`
    /// records while merely sitting open (687 attachments vs 161 assistant turns
    /// in a measured transcript), so mtime tracks UI noise and made an untouched
    /// session read as freshly active. 0 when the tail held no turn record.
    turn_ts: u64,
}

/// Short, human one-liner for a tool_use block - shared by the transcript tail
/// (fd_session_tail) and the approval-gate `wants` signal. Pulls the salient arg
/// (file, command, pattern) so a glance tells you what the session is doing.
fn describe_tool_use(name: &str, input: Option<&Value>) -> String {
    let arg = |k: &str| input.and_then(|i| i.get(k)).and_then(|x| x.as_str());
    let base = |p: &str| {
        p.trim_end_matches(['\\', '/'])
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(p)
            .to_string()
    };
    let short = |s: &str, n: usize| -> String {
        let s: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
        if s.chars().count() > n {
            format!(
                "{}…",
                s.chars()
                    .take(n.saturating_sub(1))
                    .collect::<String>()
                    .trim_end()
            )
        } else {
            s
        }
    };
    match name {
        "Edit" | "Write" | "MultiEdit" => {
            format!("✎ {name} {}", base(arg("file_path").unwrap_or("")))
        }
        "NotebookEdit" => format!(
            "✎ NotebookEdit {}",
            base(arg("notebook_path").unwrap_or(""))
        ),
        "Read" => format!("◍ Read {}", base(arg("file_path").unwrap_or(""))),
        "Bash" => format!("▸ Bash {}", short(arg("command").unwrap_or(""), 56)),
        "Grep" => format!("⌕ Grep {}", short(arg("pattern").unwrap_or(""), 42)),
        "Glob" => format!("⌕ Glob {}", short(arg("pattern").unwrap_or(""), 42)),
        "Task" => format!(
            "◇ Task {}",
            short(
                arg("description")
                    .or_else(|| arg("subagent_type"))
                    .unwrap_or(""),
                42
            )
        ),
        "WebFetch" => format!("⌘ WebFetch {}", short(arg("url").unwrap_or(""), 42)),
        "WebSearch" => format!("⌕ WebSearch {}", short(arg("query").unwrap_or(""), 42)),
        _ => format!("⚙ {name}"),
    }
}

fn read_transcript_tail(file: &Path) -> Tail {
    let mut out = Tail {
        preview: None,
        branch: None,
        model: None,
        has_edits: false,
        wants: None,
        turn_in_flight: false,
        turn_ts: 0,
    };
    let Ok(bytes) = read_tail_bytes(file, TAIL_BYTES) else {
        return out;
    };
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.split('\n').filter(|l| !l.trim().is_empty()).collect();
    // drop the (likely partial) first line
    if lines.len() > 1 {
        lines.remove(0);
    }
    let mut activity: Option<String> = None;
    let mut intent: Option<String> = None;
    for line in lines.iter().rev() {
        let Ok(o) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if out.branch.is_none() {
            if let Some(b) = o.get("gitBranch").and_then(|x| x.as_str()) {
                out.branch = Some(b.to_string());
            }
        }
        let typ = o.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let msg = o.get("message");
        if typ == "assistant" {
            if let Some(m) = msg {
                if out.model.is_none() {
                    if let Some(md) = m.get("model").and_then(|x| x.as_str()) {
                        out.model = Some(md.to_string());
                    }
                }
                if let Some(c) = m.get("content").and_then(|x| x.as_array()) {
                    if activity.is_none() {
                        activity = preview_from_blocks(c);
                    }
                    // Mark this session 'build' if it called any repo-mutating tool.
                    if !out.has_edits {
                        for b in c {
                            if b.get("type").and_then(|x| x.as_str()) == Some("tool_use") {
                                if let Some(n) = b.get("name").and_then(|x| x.as_str()) {
                                    if is_edit_tool(n) {
                                        out.has_edits = true;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } else if typ == "user" {
            if let Some(m) = msg {
                if intent.is_none() {
                    if let Some(s) = m.get("content").and_then(|x| x.as_str()) {
                        intent = clean(s);
                    } else if let Some(c) = m.get("content").and_then(|x| x.as_array()) {
                        intent = preview_from_blocks(c);
                    }
                }
            }
        }
        // No early break: we must scan the whole (bounded 64KB) tail so an edit
        // tool used a few turns back still marks the session as 'build'.
    }
    out.preview = activity.or(intent);

    // ── approval-gate scan (forward): find a trailing tool_use the assistant
    // STOPPED on that nothing later answers. A user turn (tool_result OR a fresh
    // prompt) clears the pending request. What survives to EOF is a parked tool
    // request - for a live interactive session, the permission prompt awaiting you.
    let mut pending: Option<String> = None;
    for line in lines.iter() {
        let Ok(o) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let typ = o.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let Some(m) = o.get("message") else { continue };
        if typ == "assistant" {
            let stopped_on_tool = m.get("stop_reason").and_then(|x| x.as_str()) == Some("tool_use");
            if let Some(c) = m.get("content").and_then(|x| x.as_array()) {
                let mut last_tool: Option<String> = None;
                for b in c {
                    if b.get("type").and_then(|x| x.as_str()) == Some("tool_use") {
                        if let Some(n) = b.get("name").and_then(|x| x.as_str()) {
                            last_tool = Some(describe_tool_use(n, b.get("input")));
                        }
                    }
                }
                // Only a turn that stopped to request a tool is a potential gate.
                if stopped_on_tool {
                    pending = last_tool;
                }
            }
        } else if typ == "user" {
            // Any user turn (a tool_result answering the request, or a new prompt)
            // means the request was resolved / superseded - no longer pending.
            if m.get("content").is_some() {
                pending = None;
            }
        }
    }
    out.wants = pending;

    // ── TURN STATE: is a prompt actually running? ────────────────────────────
    // Walk backwards to the last real TURN record. Everything else in a
    // transcript - attachment, queue-operation, atis-latch, bridge-session,
    // last-prompt, custom-title, mode, history-suppression - is written while the
    // session merely sits open, which is exactly why file mtime cannot answer
    // this question (see Tail::turn_ts).
    for line in lines.iter().rev() {
        let Ok(o) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let typ = o.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if typ != "user" && typ != "assistant" {
            continue;
        }
        out.turn_ts = o
            .get("timestamp")
            .and_then(|x| x.as_str())
            .and_then(parse_iso_ms)
            .unwrap_or(0);
        out.turn_in_flight = if typ == "user" {
            // A user record is the prompt OR a tool_result. Either way the
            // assistant now owes a reply - it is generating.
            true
        } else {
            // An assistant record that stopped to request a tool is still in the
            // turn; one that ended its turn is done and waiting for the owner.
            o.get("message")
                .and_then(|m| m.get("stop_reason"))
                .and_then(|x| x.as_str())
                == Some("tool_use")
        };
        break;
    }
    out
}

/// Parse a transcript ISO-8601 timestamp ("2026-09-05T20:43:09.235Z") to epoch ms
/// without pulling in chrono - this crate deliberately has no chrono dependency
/// (it uses Win32 GetLocalTime everywhere else). Returns None on any malformed
/// field so a format change degrades to "unknown", never to a wrong time.
fn parse_iso_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z)?.parse::<u64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || d == 0 || d > 31 || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    // Days from civil (Howard Hinnant's algorithm) - exact, no table, no leap bugs.
    let y_adj = if mo <= 2 { y - 1 } else { y } as i64;
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let mp = (mo as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let ms = (days * 86_400 + h as i64 * 3600 + mi as i64 * 60 + sec as i64) * 1000
        + s.get(20..23)
            .and_then(|f| f.parse::<i64>().ok())
            .unwrap_or(0);
    u64::try_from(ms).ok()
}

fn read_tail_bytes(file: &Path, max: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(file)?;
    let size = f.metadata()?.len();
    let start = size.saturating_sub(max);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::with_capacity((size - start) as usize);
    f.take(max).read_to_end(&mut buf)?;
    Ok(buf)
}

fn preview_from_blocks(content: &[Value]) -> Option<String> {
    // last visible text block
    for b in content.iter().rev() {
        if b.get("type").and_then(|x| x.as_str()) == Some("text") {
            if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                if let Some(c) = clean(t) {
                    return Some(c);
                }
            }
        }
    }
    // else describe the last tool call
    for b in content.iter().rev() {
        if b.get("type").and_then(|x| x.as_str()) == Some("tool_use") {
            if let Some(n) = b.get("name").and_then(|x| x.as_str()) {
                return Some(format!("⚙ {}", n));
            }
        }
    }
    for b in content.iter().rev() {
        if b.get("type").and_then(|x| x.as_str()) == Some("tool_result") {
            return Some("⚙ tool result".to_string());
        }
    }
    None
}

// ── git worktree topology ─────────────────────────────────────────────────────
#[derive(Clone)]
struct WorktreeInfo {
    path: String,
    branch: Option<String>,
    head: Option<String>,
}

/// A resolved repo: its identity, its full set of worktrees (main first), and an
/// optional lanes manifest parsed from a sibling `*-lanes/README.md`.
#[derive(Clone)]
struct RepoInfo {
    root_alias: Option<String>, // Desktop junction spelling, mapped to the real main lane
    key: String,                // norm(main worktree path) - same across every worktree
    root: String,               // main worktree path
    label: String,              // pretty repo name
    worktrees: Vec<WorktreeInfo>,
    specs: Vec<LaneSpec>,
}

/// One row of a `*-lanes/README.md` ops-manual table (the human source of truth
/// for ports + drivers). Matched to a git worktree by folder basename, or - when
/// it has no local folder - surfaced as a remote/cloud lane.
#[derive(Clone)]
struct LaneSpec {
    label: String,
    folder_base: Option<String>, // lowercased folder basename; None ⇒ remote
    branch: Option<String>,
    port: Option<u32>,
    driver: String,
    remote: bool,
}

/// Run a git subcommand in `cwd`, returning stdout on success. On Windows the
/// CREATE_NO_WINDOW flag keeps a GUI app from strobing a console window every poll.
fn run_git(cwd: &str, args: &[&str]) -> Option<String> {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    // Never let git ask for anything. A credential helper or terminal prompt with
    // no one to answer it blocks forever, and this runs inside the snapshot
    // rebuild - see GIT_TIMEOUT below for what "forever" used to cost.
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_OPTIONAL_LOCKS", "0");
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    let out = output_with_timeout(cmd, GIT_TIMEOUT)?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Longest any single git call inside a snapshot rebuild may run.
///
/// `run_git` used `Command::output()` with no timeout and an inherited stdin, and it
/// runs several times per worktree on every rebuild. One git that blocked - a
/// credential prompt, a held lock, a pathological worktree - never returned, so the
/// rebuild never returned, so the in-flight flag never cleared, and every later
/// poll was served the same frozen snapshot for the life of the process. That is
/// "if the app's been open for a while, nothing updates", and why a restart always
/// fixed it. A git call that exceeds this is killed and reads as "no data" for
/// that one lane, which is honest and costs one lane's diff stats, not the app.
const GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// Windows process inventory occasionally wedges even while the queried process
/// is healthy. A Flight Deck rebuild must never inherit that unbounded wait.
const PROCESS_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// A child can exit after spawning a descendant that inherited its output pipes.
/// Never let that descendant turn the reader-thread joins back into an unbounded wait.
const OUTPUT_DRAIN_GRACE: std::time::Duration = std::time::Duration::from_secs(1);

/// `Command::output()` with a deadline. The child is killed if it overruns and
/// `None` is returned. stdout/stderr are drained on their own threads so a chatty
/// child can never deadlock against a full pipe while we wait on it.
fn output_with_timeout(
    mut cmd: std::process::Command,
    timeout: std::time::Duration,
) -> Option<std::process::Output> {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        })
    };
    let out_t = drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let err_t = drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let drain_deadline = std::time::Instant::now() + OUTPUT_DRAIN_GRACE;
    while (!out_t.is_finished() || !err_t.is_finished())
        && std::time::Instant::now() < drain_deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    if !out_t.is_finished() || !err_t.is_finished() {
        return None;
    }
    Some(std::process::Output {
        status,
        stdout: out_t.join().unwrap_or_default(),
        stderr: err_t.join().unwrap_or_default(),
    })
}

// ── Per-lane diff stats (cached) ──────────────────────────────────────────────
//
// A lane's real weight = how far its worktree has diverged from the repo's base
// (integration) branch: added/deleted lines, files touched, commits ahead. We use
// the MERGE-BASE so the numstat reflects ONLY this lane's own work (and includes
// uncommitted changes in the worktree), not commits the base advanced past.

/// 30s cache keyed by "<norm worktree>||<base branch>". `build_snapshot` runs on a
/// blocking thread, so a std Mutex is fine and never touches the async IPC path.
fn diff_cache() -> &'static Mutex<HashMap<String, (u64, Option<LaneDiff>)>> {
    static C: OnceLock<Mutex<HashMap<String, (u64, Option<LaneDiff>)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cached wrapper: recompute at most every DIFF_CACHE_MS per (worktree, base).
/// `budget` = how many git shell-outs this snapshot build may still spend. Fresh
/// cache hits are free; an EXPIRED entry re-shells only while budget remains,
/// otherwise the last known value is served (honest: stale diff beats a 40s
/// build - the rolling budget refreshes the whole fleet within the TTL). A cold
/// build (budget 0) simply omits diffs; the background full build fills them.
fn lane_diff(worktree: &str, base_branch: &str, now: u64, budget: &mut i32) -> Option<LaneDiff> {
    if base_branch.is_empty() || base_branch == "(detached)" {
        return None;
    }
    let key = format!("{}||{}", norm_path(worktree), base_branch);
    let cached: Option<(u64, Option<LaneDiff>)> =
        diff_cache().lock().ok().and_then(|c| c.get(&key).cloned());
    if let Some((ts, val)) = &cached {
        if now.saturating_sub(*ts) < DIFF_CACHE_MS {
            return val.clone();
        }
    }
    if *budget <= 0 {
        // Out of shell budget this build - serve the stale value (or nothing).
        return cached.and_then(|(_, v)| v);
    }
    *budget -= 1;
    let computed = compute_lane_diff(worktree, base_branch);
    if let Ok(mut cache) = diff_cache().lock() {
        cache.insert(key, (now, computed.clone()));
    }
    computed
}

/// Shell out for the real numbers. Returns None when git can't resolve a merge-base
/// (base branch missing, not a repo) - the caller then simply omits the diff.
fn compute_lane_diff(worktree: &str, base_branch: &str) -> Option<LaneDiff> {
    let mb = run_git(worktree, &["merge-base", base_branch, "HEAD"])?;
    let mb = mb.trim();
    if mb.is_empty() {
        return None;
    }
    // `git diff --numstat <merge-base>` = working tree (incl. uncommitted) vs base.
    // Exclude lockfiles, build output and committed DATA dumps (CSV/TSV/parquet) so a
    // lane's "weight" chip reflects real source work, not a 35k-line daily_bars.csv
    // snapshot - trading-bot's lane/d read +45950 almost entirely off data files
    // (verified: 45950 → 3239 once data is excluded; genuine-source lane/a stays 15670).
    let numstat = run_git(
        worktree,
        &[
            "diff",
            "--numstat",
            mb,
            "--",
            ":(exclude)package-lock.json",
            ":(exclude)pnpm-lock.yaml",
            ":(exclude)yarn.lock",
            ":(exclude)*.lock",
            ":(exclude)*-lock.json",
            ":(exclude)*-lock.yaml",
            ":(exclude)dist/**",
            ":(exclude)build/**",
            ":(exclude)node_modules/**",
            ":(exclude)*.min.js",
            ":(exclude)*.min.css",
            ":(exclude)*.csv",
            ":(exclude)*.tsv",
            ":(exclude)*.parquet",
        ],
    )?;
    let (mut added, mut deleted, mut files) = (0u32, 0u32, 0u32);
    for line in numstat.lines() {
        let mut it = line.split('\t');
        let a = it.next().unwrap_or("");
        let d = it.next().unwrap_or("");
        let p = it.next().unwrap_or("");
        if p.is_empty() {
            continue;
        }
        files += 1;
        // Binary files report "-\t-" - parse failure → 0, which is correct.
        added += a.parse::<u32>().unwrap_or(0);
        deleted += d.parse::<u32>().unwrap_or(0);
    }
    let ahead = run_git(
        worktree,
        &["rev-list", "--count", &format!("{base_branch}..HEAD")],
    )
    .and_then(|s| s.trim().parse::<u32>().ok())
    .unwrap_or(0);
    // Real working-tree state. One extra cheap shell inside the same 60s cache and
    // spend budget the numstat above already pays for, so "MAIN CLEAN" can be a
    // measurement instead of a hardcoded string.
    let dirty_files = run_git(worktree, &["status", "--porcelain"])
        .map(|out| out.lines().filter(|l| !l.trim().is_empty()).count() as u32)
        .unwrap_or(0);
    Some(LaneDiff {
        added,
        deleted,
        files,
        ahead,
        dirty_files,
    })
}

fn parse_worktrees(text: &str) -> Vec<WorktreeInfo> {
    let mut trees: Vec<WorktreeInfo> = vec![];
    let mut cur: Option<WorktreeInfo> = None;
    for line in text.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(c) = cur.take() {
                trees.push(c);
            }
            cur = Some(WorktreeInfo {
                path: p.trim().to_string(),
                branch: None,
                head: None,
            });
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(c) = cur.as_mut() {
                c.branch = Some(b.replace("refs/heads/", "").trim().to_string());
            }
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            if let Some(c) = cur.as_mut() {
                c.head = Some(h.trim().chars().take(7).collect());
            }
        } else if line.starts_with("detached") {
            if let Some(c) = cur.as_mut() {
                c.branch = Some("(detached)".to_string());
            }
        }
    }
    if let Some(c) = cur.take() {
        trees.push(c);
    }
    trees
}

/// Resolve the repo a cwd belongs to via `git worktree list`. The first listed
/// worktree is the main one and is identical across every worktree of the repo,
/// so we use it as the stable repo identity. Returns None when git can't run or
/// the cwd isn't inside a repo (caller degrades to a single standalone lane).
fn git_resolve_repo(cwd: &str) -> Option<RepoInfo> {
    let text = run_git(cwd, &["worktree", "list", "--porcelain"])?;
    let worktrees = parse_worktrees(&text);
    if worktrees.is_empty() {
        return None;
    }
    let root = worktrees[0].path.clone();
    let key = norm_path(&root);
    let label = pretty_label(&root);
    // The lanes manifest (ports + drivers) lives next to the linked worktrees:
    // their common parent dir is the `*-lanes` folder. Robustly derived from the
    // real worktree paths rather than hard-coded.
    let other_parents: Vec<String> = worktrees[1..].iter().map(|w| parent_dir(&w.path)).collect();
    let specs = match common_dir(&other_parents) {
        Some(dir) => parse_lanes_manifest(Path::new(&dir)),
        None => vec![],
    };
    Some(RepoInfo {
        root_alias: None,
        key,
        root,
        label,
        worktrees,
        specs,
    })
}

fn strip_md(s: &str) -> String {
    // Strip bold markers + code ticks + emphasis underscores, but keep a lone '*'
    // so a glob like `cloud/*` survives (it would otherwise read as "cloud/").
    s.replace("**", "")
        .replace('`', "")
        .replace('_', " ")
        .trim()
        .to_string()
}

/// Normalize freeform driver/label text into our driver enum. Order matters:
/// the specific tool names win before the generic "integration/claude" buckets.
fn classify_driver(parts: &[&str]) -> String {
    let s = parts.join(" ").to_ascii_lowercase();
    if s.contains("cursor") {
        "cursor"
    } else if s.contains("codex") {
        "codex"
    } else if s.contains("cloud") || s.contains("claude.ai") {
        "cloud"
    } else if s.contains("integration")
        || s.contains("merge")
        || s.contains("deploy")
        || s.contains("owns")
    {
        "integration"
    } else if s.contains("max") || s.contains("claude") {
        "max"
    } else {
        "claude"
    }
    .to_string()
}

/// Parse a `*-lanes/README.md` ops manual for the lanes table (the documented
/// source of truth for dev ports + per-lane drivers, incl. remote cloud lanes).
/// Tolerant: any missing/unparseable table degrades to an empty manifest, and the
/// caller falls back to git + naming heuristics.
fn parse_lanes_manifest(dir: &Path) -> Vec<LaneSpec> {
    let p = dir.join("README.md");
    let Ok(text) = fs::read_to_string(&p) else {
        return vec![];
    };
    let rows: Vec<Vec<String>> = text
        .lines()
        .filter(|l| l.trim_start().starts_with('|'))
        .map(|l| {
            l.trim()
                .trim_matches('|')
                .split('|')
                .map(|c| c.trim().to_string())
                .collect()
        })
        .collect();
    if rows.len() < 2 {
        return vec![];
    }
    let header: Vec<String> = rows[0].iter().map(|c| c.to_ascii_lowercase()).collect();
    let find = |needle: &str| header.iter().position(|h| h.contains(needle));
    let ci_label = find("lane").unwrap_or(0);
    let ci_folder = find("folder");
    let ci_branch = find("branch");
    let ci_port = find("port");
    let ci_driver = find("driver");
    // Only treat this as the lanes table if it has both a folder and a driver col.
    if ci_folder.is_none() || ci_driver.is_none() {
        return vec![];
    }
    let mut specs = vec![];
    for row in rows.iter().skip(1) {
        // skip the |---|---| separator
        if row.iter().all(|c| {
            c.chars()
                .all(|ch| ch == '-' || ch == ':' || ch.is_whitespace())
        }) {
            continue;
        }
        let cell = |i: Option<usize>| -> String {
            i.and_then(|i| row.get(i))
                .map(|s| strip_md(s))
                .unwrap_or_default()
        };
        let label = strip_md(row.get(ci_label).map(|s| s.as_str()).unwrap_or(""));
        let folder_raw = cell(ci_folder);
        let branch_raw = cell(ci_branch);
        let port_raw = cell(ci_port);
        let driver_raw = cell(ci_driver);
        if label.is_empty() && folder_raw.is_empty() && driver_raw.is_empty() {
            continue;
        }
        let folder_low = folder_raw.to_ascii_lowercase();
        let no_folder = folder_raw.is_empty()
            || folder_low.contains("no local")
            || folder_low.contains("n/a")
            || folder_low.contains("none");
        let folder_base = if no_folder {
            None
        } else {
            // take the token before any parenthetical note, then the basename
            let tok = folder_raw.split('(').next().unwrap_or(&folder_raw).trim();
            Some(basename(tok).to_ascii_lowercase())
        };
        let port: Option<u32> = {
            let digits: String = port_raw.chars().filter(|c| c.is_ascii_digit()).collect();
            digits.parse::<u32>().ok()
        };
        let branch = {
            // prefer a token that looks like a ref (contains '/')
            let cand = branch_raw
                .split([' ', '(', ')'])
                .find(|t| t.contains('/'))
                .map(|t| t.to_string())
                .or_else(|| {
                    if branch_raw.is_empty() {
                        None
                    } else {
                        Some(branch_raw.clone())
                    }
                });
            cand.map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty() && x.to_ascii_lowercase() != "n/a")
        };
        let driver = classify_driver(&[
            &driver_raw,
            &label,
            branch.as_deref().unwrap_or(""),
            folder_base.as_deref().unwrap_or(""),
        ]);
        let remote = no_folder || driver == "cloud";
        specs.push(LaneSpec {
            label,
            folder_base,
            branch,
            port,
            driver,
            remote,
        });
    }
    specs
}

// ── Per-lane session aggregation ──────────────────────────────────────────────
struct LaneBundle {
    cards: Vec<SessionCard>,
    live_count: u32,
    recent_count: u32,
    live_builder_count: u32,
    overflow: u32,
}

/// Build the card list + counts for one working directory (lane) from its
/// non-archived session records. Mirrors the original per-cwd logic.
fn build_lane_bundle(
    cwd: &str,
    group: Vec<&Record>,
    running: &HashMap<String, u32>,
    spawned: &HashSet<u32>,
    proj: &Path,
    now: u64,
) -> LaneBundle {
    let enc_dir = proj.join(encode_cwd(cwd));
    struct Built {
        card: SessionCard,
        running: bool,
        status_recent: bool,
        sort_mtime: u64,
    }
    let mut built: Vec<Built> = vec![];
    for r in group {
        let is_running = running.contains_key(&r.cli_session_id);
        let transcript = enc_dir.join(format!("{}.jsonl", r.cli_session_id));
        let tail = if transcript.exists() {
            read_transcript_tail(&transcript)
        } else {
            Tail {
                preview: None,
                branch: None,
                model: None,
                has_edits: false,
                wants: None,
                turn_in_flight: false,
                turn_ts: 0,
            }
        };
        // AGE = time since the last real TURN, not since the file was touched.
        // A session sitting open writes attachment/queue-operation records
        // constantly, so mtime made an untouched session read as freshly active.
        // Falls back to mtime, then to the store's lastActivityAt.
        let last = if tail.turn_ts > 0 {
            tail.turn_ts
        } else {
            mtime_ms(&transcript)
                .unwrap_or(r.last_activity_at)
                .max(r.last_activity_at)
        };
        let age = now.saturating_sub(last);
        // A prompt is genuinely running only if the process is alive AND the
        // transcript's last turn is still open AND that turn is fresh - a turn
        // "in flight" for minutes is parked or wedged, not working.
        let is_working =
            is_running && tail.turn_in_flight && now.saturating_sub(last) < WORKING_STALE_MS;
        let status = if is_working {
            "live"
        } else if is_running {
            // Open but not executing. It still belongs on the deck (it is in the
            // sidebar) - it just must not read as, or orbit like, active work.
            "recent"
        } else {
            liveness(age)
        };
        let model = r.model.clone().or(tail.model);
        let model_label = model.as_deref().and_then(pretty_model);
        let recent = !is_running && age < RECENT_MS;
        let role = if tail.has_edits { "build" } else { "passive" };
        // PARKED on a tool, not merely running one.
        //
        // A trailing un-answered tool_use means one of two things - the tool is
        // executing, or the session is waiting for the owner to approve it - and the
        // deck's deviations doc recorded that the transcript could not tell them
        // apart. It can now: `is_working` means that turn has written recently, so
        // the tool is RUNNING. Only a live process whose turn has gone quiet is
        // actually parked at a gate. Without this a session busily executing Bash
        // rendered as "TOOL PENDING" and did not count toward LIVE.
        //
        // Still no age cap on the parked case itself - a session waiting 45 min on
        // an approval is exactly the one worth surfacing.
        let wants = if is_running && !is_working {
            tail.wants.clone()
        } else {
            None
        };
        built.push(Built {
            running: is_running,
            status_recent: recent,
            sort_mtime: last,
            card: SessionCard {
                owner: SessionOwner::Zach,
                activity: if is_working { "running" } else { "active" }.into(),
                cwd: cwd.into(),
                id: r.cli_session_id.clone(),
                title: card_title(
                    r.title.as_deref(),
                    tail.preview.as_deref(),
                    &r.cli_session_id,
                ),
                status: status.to_string(),
                age_ms: age,
                mtime: last,
                model,
                model_label,
                effort: r.effort.clone(),
                preview: tail.preview,
                branch: tail.branch,
                running: is_running,
                working: is_working,
                origin: match running.get(&r.cli_session_id) {
                    Some(pid) if spawned.contains(pid) => "praxis".to_string(),
                    _ => "manual".to_string(),
                },
                pid: running.get(&r.cli_session_id).copied(),
                role: role.to_string(),
                wants,
            },
        });
    }

    // LIVE means a prompt is RUNNING, not "a window is open". These counts drive
    // the deck's N LIVE / N FIRING readouts and the orbiting agents in the brain,
    // so counting open-but-idle sessions here is what put agents in orbit with
    // nothing running.
    let live_count = built.iter().filter(|b| b.card.working).count() as u32;
    // OPEN but not executing (plus genuinely recent finished work) - the calm tier.
    let recent_count = built
        .iter()
        .filter(|b| (b.running && !b.card.working) || b.status_recent)
        .count() as u32;
    let live_builder_count = built
        .iter()
        .filter(|b| b.card.working && b.card.role == "build")
        .count() as u32;

    // Cards: EVERY non-archived session - running, recently-finished, AND dormant. A task
    // that finished but you haven't archived yet still matters, so it stays on the deck
    // Classification must see every record. Order: actually working → open → recent → newest first.
    built.sort_by(|a, b| {
        b.card
            .working
            .cmp(&a.card.working)
            .then(b.running.cmp(&a.running))
            .then(b.status_recent.cmp(&a.status_recent))
            .then(b.sort_mtime.cmp(&a.sort_mtime))
    });
    let total_built = built.len();
    let cards: Vec<SessionCard> = built.into_iter().map(|b| b.card).collect();
    let overflow = total_built.saturating_sub(cards.len()) as u32;

    LaneBundle {
        cards,
        live_count,
        recent_count,
        live_builder_count,
        overflow,
    }
}

// ── Repo assembly ─────────────────────────────────────────────────────────────
struct RepoAccum {
    info: RepoInfo,
    bundles: HashMap<String, LaneBundle>, // norm worktree path → its sessions
    archived: HashMap<String, u32>,       // norm worktree path → archived count
}

fn driver_rank(driver: &str, is_integration: bool) -> u8 {
    if is_integration {
        return 0;
    }
    match driver {
        "max" => 1,
        "cursor" => 2,
        "codex" => 3,
        "claude" => 4,
        "cloud" => 6,
        _ => 5,
    }
}

// ── Codex CLI session detection ───────────────────────────────────────────────
//
// Codex stores transcripts as date-bucketed JSONL files under ~/.codex/sessions/
// and ~/.codex/archived_sessions/. Each file's first line is a `session_meta`
// event whose payload.cwd tells us which project it belongs to. The session index
// at ~/.codex/session_index.jsonl maps id → thread_name (the human title).
//
// Running detection (no pid file):
//   • Last JSONL line is an unmatched `task_started` (paired by turn_id with
//     `task_complete`) - i.e. a task is in flight.
//   • File mtime is fresh (< LIVE_MS).
//   • A `codex.exe` process is alive on Windows.
//
// We surface these as synthetic SessionCards (id = codex session id, driver = "codex").

#[derive(Debug)]
struct CodexSession {
    owner: SessionOwner,
    /// Last 12 hex chars of the full uuid - card id is `codex:{id}` (locks/pins).
    id: String,
    cwd: String,
    title: Option<String>,
    model: Option<String>,
    mtime: u64,
    running: bool,
}

fn codex_home() -> PathBuf {
    home_dir().join(".codex")
}

/// Full session uuid from a rollout filename stem (`rollout-<ISO>-<uuid>`).
/// Takes the last 36 characters (8-4-4-4-12). Falls back to the final `-` token.
fn codex_uuid_from_stem(stem: &str) -> String {
    if stem.len() >= 36 {
        let candidate = &stem[stem.len() - 36..];
        if candidate.chars().filter(|c| *c == '-').count() == 4 {
            return candidate.to_string();
        }
    }
    stem.rsplit('-')
        .next()
        .map(|s| s.to_string())
        .unwrap_or_else(|| stem.to_string())
}

/// Card-id suffix: last 12 chars of the full uuid (locks/pins key off this).
fn codex_card_id_suffix(full_uuid: &str) -> String {
    full_uuid
        .rsplit('-')
        .next()
        .unwrap_or(full_uuid)
        .chars()
        .rev()
        .take(12)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

/// Build a map of Codex session id → thread_name from ~/.codex/session_index.jsonl.
fn codex_index() -> HashMap<String, String> {
    let mut out = HashMap::new();
    let p = codex_home().join("session_index.jsonl");
    let Ok(raw) = fs::read_to_string(&p) else {
        return out;
    };
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let id = v.get("id").and_then(|x| x.as_str());
        let name = v.get("thread_name").and_then(|x| x.as_str());
        if let (Some(id), Some(name)) = (id, name) {
            out.insert(id.to_string(), name.to_string());
        }
    }
    out
}

/// True iff a `codex.exe` (or node-based codex) process is alive right now.
fn codex_process_alive() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // codex ships as three different binaries; match any of them
        for image in ["codex.exe", "node.exe"] {
            let filter = format!("IMAGENAME eq {image}");
            let mut cmd = std::process::Command::new("tasklist");
            cmd.args(["/NH", "/FO", "CSV", "/FI", filter.as_str()])
                .creation_flags(0x0800_0000);
            let Some(out) = output_with_timeout(cmd, PROCESS_PROBE_TIMEOUT) else {
                continue;
            };
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                if line.to_ascii_lowercase().contains("codex") {
                    return true;
                }
            }
        }
        false
    }
    #[cfg(not(windows))]
    {
        let mut cmd = std::process::Command::new("pgrep");
        cmd.arg("-f").arg("codex");
        output_with_timeout(cmd, PROCESS_PROBE_TIMEOUT)
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Determine whether a Codex JSONL transcript is currently running:
///   last line is a `task_started` whose turn_id has no matching `task_complete`.
fn codex_transcript_running(file: &Path) -> bool {
    let Ok(bytes) = read_tail_bytes(file, TAIL_BYTES) else {
        return false;
    };
    let text = String::from_utf8_lossy(&bytes);
    // Only look at complete lines (drop a partial first line from the seek offset).
    let mut lines: Vec<&str> = text.split('\n').filter(|l| !l.trim().is_empty()).collect();
    if lines.len() > 1 {
        lines.remove(0);
    }

    let mut started_ids: HashSet<String> = HashSet::new();
    let mut completed_ids: HashSet<String> = HashSet::new();

    for line in &lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let typ = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        // event_msg wrapper: payload.type
        if typ == "event_msg" {
            let payload = v.get("payload");
            let inner_type = payload.and_then(|p| p.get("type")).and_then(|x| x.as_str());
            let turn_id = payload
                .and_then(|p| p.get("turn_id"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string())
                .or_else(|| {
                    v.get("turn_id")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string())
                });
            match inner_type {
                Some("task_started") => {
                    if let Some(id) = turn_id {
                        started_ids.insert(id);
                    }
                }
                Some("task_complete") => {
                    if let Some(id) = turn_id {
                        completed_ids.insert(id);
                    }
                }
                _ => {}
            }
        }
    }

    // Running = at least one task_started with no matching task_complete
    started_ids.iter().any(|id| !completed_ids.contains(id))
}

/// Clean a session title for display: strip markdown / list noise, collapse
/// whitespace, and reject placeholder junk like "session codex:" (seen leaking
/// from the codex index as literal card names). None = caller falls back.
fn sanitize_title(raw: &str) -> Option<String> {
    let stripped: String = raw
        .replace("**", "")
        .replace('`', "")
        .trim_start_matches(|c: char| "#*>-—·:".contains(c) || c.is_whitespace())
        .to_string();
    let joined = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    // Trim wrapping/edge quotes so a name never renders as  "…"  or  '…' .
    let s = joined
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '“' | '”' | '‘' | '’'))
        .trim()
        .to_string();
    let low = s.to_ascii_lowercase();
    if s.chars().count() < 3
        || s.starts_with('<') // XML/HTML tag scaffolding, e.g. "<recommended_plugins>"
        || low.starts_with("session codex")
        || low.starts_with("session cursor")
        || low == "session"
        || low == "codex"
        || low == "cursor"
    {
        return None;
    }
    Some(s)
}

/// Best display title for a card, uniform across every driver (claude / codex /
/// cursor): a sanitized real title, else the first meaningful words of a fallback
/// snippet (transcript preview / first prompt), else a stable `SESSION <ID6>`.
/// This is the ONE place the "sanitized title → first-prompt/preview words →
/// SESSION <id6>" discipline lives, so no raw markdown, tag noise, or placeholder
/// junk (e.g. "SESSION CURSOR") ever reaches a card name.
fn card_title(raw_title: Option<&str>, fallback: Option<&str>, id: &str) -> Option<String> {
    if let Some(t) = raw_title.and_then(sanitize_title) {
        return Some(t);
    }
    if let Some(p) = fallback.and_then(sanitize_title) {
        let words: Vec<&str> = p.split_whitespace().take(6).collect();
        if !words.is_empty() {
            return Some(words.join(" "));
        }
    }
    let id6: String = id.chars().take(6).collect::<String>().to_uppercase();
    Some(format!("SESSION {id6}"))
}

/// Last-resort Codex title: `"<folder> · <id6>"` in lowercase.
fn codex_folder_title(cwd: &str, id: &str) -> String {
    let folder = Path::new(cwd)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("session")
        .to_ascii_lowercase();
    let id6: String = id.chars().take(6).collect::<String>().to_ascii_lowercase();
    format!("{folder} · {id6}")
}

/// Pull the inner text of `<tag>…</tag>` (first match), trimmed.
fn extract_xml_tag_text(raw: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = raw.find(&open)? + open.len();
    let end = raw[start..].find(&close)? + start;
    let inner = raw[start..end].trim();
    if inner.is_empty() {
        None
    } else {
        Some(inner.to_string())
    }
}

/// Turn raw user text into a real prompt candidate, or None if it is injected scaffolding.
fn codex_real_prompt_text(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    if t.contains("<realtime_delegation>") {
        return extract_xml_tag_text(t, "input");
    }
    if t.starts_with('<') {
        return None;
    }
    if t.starts_with("# AGENTS.md") {
        return None;
    }
    Some(t.to_string())
}

fn first_n_words(text: &str, n: usize) -> Option<String> {
    let words: Vec<&str> = text.split_whitespace().take(n).collect();
    if words.is_empty() {
        None
    } else {
        Some(words.join(" "))
    }
}

fn response_item_user_text(v: &Value) -> Option<&str> {
    let role = v
        .pointer("/payload/role")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    if role != "user" {
        return None;
    }
    v.pointer("/payload/content/0/text")
        .and_then(|x| x.as_str())
        .or_else(|| v.pointer("/payload/text").and_then(|x| x.as_str()))
        .or_else(|| v.pointer("/payload/content").and_then(|x| x.as_str()))
}

/// First real user-prompt snippet from a codex rollout transcript.
/// Reads ≤600 lines. Prefers `event_msg` / `user_message`; else user `response_item`
/// text, skipping injected `<…>` / `# AGENTS.md` blocks; `<realtime_delegation>`
/// uses the `<input>` body. Title = first ~8 words.
fn codex_first_prompt(file: &Path) -> Option<String> {
    let f = fs::File::open(file).ok()?;
    let reader = std::io::BufReader::new(f);
    let mut event_msg_hit: Option<String> = None;
    let mut response_item_hit: Option<String> = None;
    for (i, line) in reader.lines().map_while(Result::ok).enumerate() {
        if i >= 600 {
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        let typ = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if typ == "event_msg" {
            let payload = v.get("payload");
            let inner = payload.and_then(|p| p.get("type")).and_then(|x| x.as_str());
            if inner == Some("user_message") {
                if let Some(msg) = payload
                    .and_then(|p| p.get("message"))
                    .and_then(|x| x.as_str())
                {
                    if let Some(real) = codex_real_prompt_text(msg) {
                        if event_msg_hit.is_none() {
                            event_msg_hit = first_n_words(&real, 8);
                        }
                    }
                }
            }
        } else if typ == "response_item" {
            if let Some(text) = response_item_user_text(&v) {
                if let Some(real) = codex_real_prompt_text(text) {
                    if response_item_hit.is_none() {
                        response_item_hit = first_n_words(&real, 8);
                    }
                }
            }
        }
        if event_msg_hit.is_some() {
            break;
        }
    }
    event_msg_hit.or(response_item_hit)
}

/// Title order: session_index by full filename uuid → by session_meta id →
/// first real user prompt → `"<folder> · <id6>"` lowercase.
fn resolve_codex_title(
    index: &HashMap<String, String>,
    full_uuid: &str,
    meta_id: Option<&str>,
    prompt: Option<&str>,
    cwd: &str,
    id12: &str,
) -> String {
    if let Some(t) = index.get(full_uuid).and_then(|t| sanitize_title(t)) {
        return t;
    }
    if let Some(mid) = meta_id {
        if let Some(t) = index.get(mid).and_then(|t| sanitize_title(t)) {
            return t;
        }
    }
    if let Some(p) = prompt.and_then(sanitize_title) {
        if let Some(words) = first_n_words(&p, 8) {
            return words;
        }
    }
    codex_folder_title(cwd, id12)
}

/// Rich parse of the first `session_meta` line.
struct CodexSessionMeta {
    owner: SessionOwner,
    cwd: Option<String>,
    model: Option<String>,
    meta_id: Option<String>,
    parent_thread_id: Option<String>,
    originator: Option<String>,
}

fn parse_codex_session_meta(file: &Path) -> CodexSessionMeta {
    let empty = CodexSessionMeta {
        owner: SessionOwner::Zach,
        cwd: None,
        model: None,
        meta_id: None,
        parent_thread_id: None,
        originator: None,
    };
    let Ok(f) = fs::File::open(file) else {
        return empty;
    };
    let mut reader = std::io::BufReader::new(f);
    let mut first = String::new();
    if reader.read_line(&mut first).is_err() {
        return empty;
    }
    let Ok(v) = serde_json::from_str::<Value>(first.trim()) else {
        return empty;
    };
    let cwd = v
        .pointer("/payload/cwd")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let model = v
        .pointer("/payload/model_provider")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let meta_id = v
        .pointer("/payload/id")
        .and_then(|x| x.as_str())
        .or_else(|| v.pointer("/payload/session_id").and_then(|x| x.as_str()))
        .map(|s| s.to_string());
    let parent_thread_id = v
        .pointer("/payload/source/subagent/thread_spawn/parent_thread_id")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    let originator = v
        .pointer("/payload/originator")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    CodexSessionMeta {
        owner: codex_owner(v.get("payload").unwrap_or(&Value::Null)),
        cwd,
        model,
        meta_id,
        parent_thread_id,
        originator,
    }
}

fn codex_transcript_meta(file: &Path) -> (Option<String>, Option<String>) {
    let m = parse_codex_session_meta(file);
    (m.cwd, m.model)
}

/// Metadata and first-prompt cache, invalidated by rollout mtime.
struct CodexMeta {
    owner: SessionOwner,
    mtime: u64,
    cwd: Option<String>,
    model: Option<String>,
    meta_id: Option<String>,
    parent_thread_id: Option<String>,
    originator: Option<String>,
    /// None = first-prompt fallback not computed yet; Some(inner) = computed.
    prompt: Option<Option<String>>,
}

fn codex_meta_cache() -> &'static Mutex<HashMap<String, CodexMeta>> {
    static C: OnceLock<Mutex<HashMap<String, CodexMeta>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn clear_codex_meta_cache() {
    if let Ok(mut cache) = codex_meta_cache().lock() {
        cache.clear();
    }
}

fn cached_codex_meta_full(p: &Path, mtime: u64) -> CodexSessionMeta {
    let key = p.to_string_lossy().into_owned();
    if let Ok(cache) = codex_meta_cache().lock() {
        if let Some(m) = cache.get(&key) {
            if m.mtime == mtime {
                return CodexSessionMeta {
                    owner: m.owner,
                    cwd: m.cwd.clone(),
                    model: m.model.clone(),
                    meta_id: m.meta_id.clone(),
                    parent_thread_id: m.parent_thread_id.clone(),
                    originator: m.originator.clone(),
                };
            }
        }
    }
    let parsed = parse_codex_session_meta(p);
    if let Ok(mut cache) = codex_meta_cache().lock() {
        cache.insert(
            key,
            CodexMeta {
                owner: parsed.owner,
                mtime,
                cwd: parsed.cwd.clone(),
                model: parsed.model.clone(),
                meta_id: parsed.meta_id.clone(),
                parent_thread_id: parsed.parent_thread_id.clone(),
                originator: parsed.originator.clone(),
                prompt: None,
            },
        );
    }
    parsed
}

fn cached_codex_first_prompt(p: &Path, mtime: u64) -> Option<String> {
    let key = p.to_string_lossy().into_owned();
    if let Ok(mut cache) = codex_meta_cache().lock() {
        if let Some(m) = cache.get_mut(&key) {
            if m.mtime == mtime {
                if let Some(pr) = &m.prompt {
                    return pr.clone();
                }
                let pr = codex_first_prompt(p);
                m.prompt = Some(pr.clone());
                return pr;
            }
        }
    }
    // Not cached (or lock poisoned) - read directly; the next cached_codex_meta
    // pass will repopulate the entry.
    codex_first_prompt(p)
}

fn scan_codex_dir(
    dir: &Path,
    tracked: &HashSet<String>,
    index: &HashMap<String, String>,
    process_alive: bool,
    now: u64,
    out: &mut Vec<CodexSession>,
    hidden_older: &mut u32,
) {
    // Recurse up to 4 levels (YYYY/MM/DD/rollout-*.jsonl for active;
    // flat for archived).
    scan_codex_dir_inner(
        dir,
        tracked,
        index,
        process_alive,
        now,
        out,
        hidden_older,
        0,
    );
}

fn scan_codex_dir_inner(
    dir: &Path,
    tracked: &HashSet<String>,
    index: &HashMap<String, String>,
    process_alive: bool,
    now: u64,
    out: &mut Vec<CodexSession>,
    hidden_older: &mut u32,
    depth: usize,
) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            scan_codex_dir_inner(
                &p,
                tracked,
                index,
                process_alive,
                now,
                out,
                hidden_older,
                depth + 1,
            );
            continue;
        }
        // Only process rollout-*.jsonl files
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
            continue;
        }

        let mtime = mtime_ms(&p).unwrap_or(0);
        let age = now.saturating_sub(mtime);
        // Codex keeps every rollout forever. Apply the user's ACTIVE WINDOW before
        // opening metadata and scanning up to 600 prompt lines; the old path read
        // hundreds of invisible transcripts on every cold build (100s measured on
        // this machine) and only discarded them later in `route_sessions`.
        if !within_active_window(age, false) {
            *hidden_older += 1;
            continue;
        }
        let meta = cached_codex_meta_full(&p, mtime);
        let Some(cwd) = meta.cwd else { continue };

        let stem = name.trim_end_matches(".jsonl");
        let full_uuid = codex_uuid_from_stem(stem);
        let id = codex_card_id_suffix(&full_uuid);
        // Most user-owned sessions already have a real name in session_index.
        // Do not scan up to 600 transcript rows for a fallback the resolver will
        // never use; this keeps the explicit "All" window viable as well as the
        // default recent-window fast path.
        let has_indexed_title = index
            .get(&full_uuid)
            .and_then(|t| sanitize_title(t))
            .or_else(|| {
                meta.meta_id
                    .as_deref()
                    .and_then(|mid| index.get(mid))
                    .and_then(|t| sanitize_title(t))
            })
            .is_some();
        let prompt = if has_indexed_title {
            None
        } else {
            cached_codex_first_prompt(&p, mtime)
        };
        let title = Some(resolve_codex_title(
            index,
            &full_uuid,
            meta.meta_id.as_deref(),
            prompt.as_deref(),
            &cwd,
            &id,
        ));

        let running = process_alive && age < LIVE_MS && codex_transcript_running(&p);
        out.push(CodexSession {
            owner: meta.owner,
            id,
            cwd,
            title,
            model: meta.model,
            mtime,
            running,
        });
    }
}

#[derive(Default)]
struct CodexCensus {
    sessions: Vec<CodexSession>,
    hidden_older: u32,
}

/// Deduplicate reader output; classification and exclusions belong to route_sessions.
fn finalize_codex_sessions(raw: Vec<CodexSession>) -> Vec<CodexSession> {
    // Dedup by card id - keep newest mtime
    let mut by_id: HashMap<String, CodexSession> = HashMap::new();
    for s in raw {
        match by_id.get(&s.id) {
            Some(prev) if prev.mtime >= s.mtime => {}
            _ => {
                by_id.insert(s.id.clone(), s);
            }
        }
    }
    by_id.into_values().collect()
}

/// Return all Codex sessions relevant to the given tracked repo roots.
fn codex_sessions(tracked: &HashSet<String>, now: u64) -> CodexCensus {
    let home = codex_home();
    let active_dir = home.join("sessions");
    if !active_dir.exists() {
        return CodexCensus {
            sessions: vec![],
            hidden_older: 0,
        };
    }

    let index = codex_index();
    let process_alive = codex_process_alive();
    let mut out: Vec<CodexSession> = vec![];
    let mut hidden_older = 0;

    scan_codex_dir(
        &active_dir,
        tracked,
        &index,
        process_alive,
        now,
        &mut out,
        &mut hidden_older,
    );
    CodexCensus {
        sessions: finalize_codex_sessions(out),
        hidden_older,
    }
}

// ── Cursor Composer session detection ─────────────────────────────────────────
//
// Cursor stores its composer (chat/agent) sessions in a SQLite WAL database at
// %APPDATA%\Cursor\User\globalStorage\state.vscdb. We open it READ-ONLY using
// a WAL-aware connection so newly committed conversations are visible on reload.
//
// The session index lives in ItemTable under the key `composer.composerHeaders`
// as a JSON blob: { allComposers: [{composerId, name, unifiedMode, isArchived,
// workspaceIdentifier.uri.fsPath, lastUpdatedAt, ...}] }.
//
// Active heuristic (Cursor exposes no per-session pid):
//   1. Cursor.exe is alive and state.vscdb-wal is fresh (process heartbeat).
//   2. THIS composer's own timestamp is fresh (the global WAL alone is never enough).
//   3. It is an agent-mode composer whose transcript has an unmatched user turn.
// Only an active agent with an editable workspace counts as a collision-capable builder.

struct CursorSession {
    bubble_count: usize,
    id: String,
    cwd: String,
    title: Option<String>,
    model: Option<String>, // always None for now - not stored in composerHeaders
    mtime: u64,
    running: bool,
    mutable: bool,
}

fn cursor_db_path() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    let p = PathBuf::from(appdata)
        .join("Cursor")
        .join("User")
        .join("globalStorage")
        .join("state.vscdb");
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

fn cursor_wal_path() -> Option<PathBuf> {
    let mut p = cursor_db_path()?;
    let name = p.file_name()?.to_string_lossy().into_owned() + "-wal";
    p.set_file_name(name);
    Some(p)
}

/// True iff a Cursor.exe process is alive right now.
fn cursor_process_alive() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("tasklist");
        cmd.args(["/NH", "/FO", "CSV", "/FI", "IMAGENAME eq Cursor.exe"])
            .creation_flags(0x0800_0000);
        let Some(out) = output_with_timeout(cmd, PROCESS_PROBE_TIMEOUT) else {
            return false;
        };
        let text = String::from_utf8_lossy(&out.stdout);
        text.lines()
            .any(|l| l.to_ascii_lowercase().contains("cursor.exe"))
    }
    #[cfg(not(windows))]
    {
        let mut cmd = std::process::Command::new("pgrep");
        cmd.arg("-f").arg("Cursor");
        output_with_timeout(cmd, PROCESS_PROBE_TIMEOUT)
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// Check whether an agent-mode transcript for a Cursor composer is in-flight.
/// Path: ~/.cursor/projects/<projectId>/agent-transcripts/<composerId>/<composerId>.jsonl
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CursorTurnState {
    InFlight,
    Ended,
    Unknown,
}

/// Find the newest meaningful turn boundary in a Cursor agent transcript tail.
/// Tool/result/metadata rows after `turn_ended` are deliberately ignored. Likewise,
/// malformed tail rows fail closed instead of turning an old session live.
fn cursor_turn_state_from_tail(text: &str, first_line_is_partial: bool) -> CursorTurnState {
    let lines: Vec<&str> = text.split('\n').filter(|l| !l.trim().is_empty()).collect();
    let check_lines = if first_line_is_partial && lines.len() > 1 {
        &lines[1..]
    } else {
        &lines[..]
    };

    for line in check_lines.iter().rev() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match v.get("type").and_then(|x| x.as_str()) {
            Some("turn_ended") => return CursorTurnState::Ended,
            Some("turn_started") => return CursorTurnState::InFlight,
            _ => {}
        }
        // Current Cursor transcripts begin a turn with a role=user row rather
        // than a dedicated turn_started marker.
        if v.get("role").and_then(|x| x.as_str()) == Some("user") {
            return CursorTurnState::InFlight;
        }
    }
    CursorTurnState::Unknown
}

fn cursor_transcript_in_flight(composer_id: &str) -> bool {
    // Glob ~/.cursor/projects/*/agent-transcripts/<id>/<id>.jsonl
    let cursor_home = home_dir().join(".cursor").join("projects");
    let Ok(projects) = fs::read_dir(&cursor_home) else {
        return false;
    };
    for proj in projects.flatten() {
        let transcript = proj
            .path()
            .join("agent-transcripts")
            .join(composer_id)
            .join(format!("{}.jsonl", composer_id));
        if !transcript.exists() {
            continue;
        }
        let tail_is_truncated = fs::metadata(&transcript)
            .map(|m| m.len() > TAIL_BYTES)
            .unwrap_or(false);
        let Ok(bytes) = read_tail_bytes(&transcript, TAIL_BYTES) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        return cursor_turn_state_from_tail(&text, tail_is_truncated) == CursorTurnState::InFlight;
    }
    false
}

/// Cursor versions do not consistently populate `lastUpdatedAt`. Preserve the
/// newest real per-composer timestamp instead of stamping a missing value as now.
fn cursor_composer_mtime(composer: &Value) -> u64 {
    let raw = [
        "lastUpdatedAt",
        "conversationCheckpointLastUpdatedAt",
        "createdAt",
    ]
    .iter()
    .filter_map(|key| composer.get(*key).and_then(|x| x.as_u64()))
    .filter(|ts| *ts > 0)
    .max()
    .unwrap_or(0);
    cursor_normalize_timestamp(raw)
}

fn cursor_composer_is_fresh(now: u64, mtime: u64) -> bool {
    mtime > 0 && mtime <= now.saturating_add(LIVE_MS) && now.saturating_sub(mtime) < LIVE_MS
}

fn cursor_composer_is_mutable_agent(composer: &Value) -> bool {
    composer.get("unifiedMode").and_then(|x| x.as_str()) == Some("agent")
        && composer.get("forceMode").and_then(|x| x.as_str()) == Some("edit")
        && composer
            .get("worktreeStartedReadOnly")
            .and_then(|x| x.as_bool())
            == Some(false)
}

fn cursor_composer_is_running(
    now: u64,
    mtime: u64,
    process_alive: bool,
    wal_fresh: bool,
    is_agent: bool,
    transcript_in_flight: bool,
) -> bool {
    process_alive
        && wal_fresh
        && cursor_composer_is_fresh(now, mtime)
        && is_agent
        && transcript_in_flight
}

/// `%APPDATA%\Cursor\User\workspaceStorage` - one directory per workspace, each
/// holding a `workspace.json` that names the folder it was opened on.
fn cursor_workspace_storage_dir() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    Some(
        PathBuf::from(appdata)
            .join("Cursor")
            .join("User")
            .join("workspaceStorage"),
    )
}

/// Decode a `file:///c%3A/Users/...` URI into a Windows path. Hand-rolled because
/// this is the only percent-decoding in the app and it is not worth a dependency.
fn cursor_uri_to_path(uri: &str) -> Option<String> {
    let rest = uri
        .strip_prefix("file:///")
        .or_else(|| uri.strip_prefix("file://"))?;
    let bytes = rest.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'/' { b'\\' } else { bytes[i] });
        i += 1;
    }
    let path = String::from_utf8(out).ok()?;
    if path.trim().is_empty() {
        None
    } else {
        Some(path)
    }
}

/// Synthetic cwd for Cursor's Agents window (no folder / `empty-window`).
/// Grouped as its own deck card the way Codex groups untracked folders by cwd.
const CURSOR_AGENTS_CWD: &str = "Cursor";

#[derive(Debug, Clone, PartialEq, Eq)]
enum CursorCwd {
    Folder(String),
    Agents,
    Missing(String),
}

fn cursor_cwd_path(cwd: &CursorCwd) -> Option<String> {
    match cwd {
        CursorCwd::Folder(p) => Some(p.clone()),
        CursorCwd::Agents => Some(CURSOR_AGENTS_CWD.to_string()),
        CursorCwd::Missing(_) => None,
    }
}

/// Pull a filesystem path out of `workspaceIdentifier`, including the shape
/// that has a URI but no `fsPath` (multi-root / Agents leftovers).
fn cursor_path_from_workspace_identifier(wi: &Value) -> Option<String> {
    let uri = wi.get("uri")?;
    if let Some(fs) = uri
        .get("fsPath")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(fs.to_string());
    }
    if let Some(ext) = uri.get("external").and_then(|x| x.as_str()) {
        if let Some(p) = cursor_uri_to_path(ext) {
            return Some(p);
        }
    }
    if let Some(path) = uri
        .get("path")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let trimmed = path.trim_start_matches('/');
        if trimmed.len() >= 2 && trimmed.as_bytes().get(1) == Some(&b':') {
            return Some(trimmed.replace('/', "\\"));
        }
        if let Some(p) = cursor_uri_to_path(&format!("file://{path}")) {
            return Some(p);
        }
    }
    None
}

/// First folder listed in a VS Code / Cursor multi-root `.code-workspace` file.
fn cursor_first_folder_in_code_workspace(ws_file: &Path) -> Option<String> {
    let body = fs::read_to_string(ws_file).ok()?;
    let v: Value = serde_json::from_str(&body).ok()?;
    let first = v
        .get("folders")
        .and_then(|x| x.as_array())
        .and_then(|a| a.first())
        .and_then(|f| f.get("path"))
        .and_then(|x| x.as_str())?;
    let resolved = if Path::new(first).is_absolute() {
        PathBuf::from(first)
    } else {
        ws_file.parent()?.join(first)
    };
    if resolved.is_dir() {
        Some(resolved.to_string_lossy().into_owned())
    } else {
        None
    }
}

fn cursor_resolve_path_to_cwd(path: &str) -> CursorCwd {
    let p = Path::new(path);
    if p.is_dir() {
        return CursorCwd::Folder(path.to_string());
    }
    if path.to_ascii_lowercase().ends_with(".code-workspace") {
        if let Some(folder) = cursor_first_folder_in_code_workspace(p) {
            return CursorCwd::Folder(folder);
        }
        if let Some(parent) = p.parent() {
            if parent.is_dir() {
                return CursorCwd::Folder(parent.to_string_lossy().into_owned());
            }
        }
        return CursorCwd::Missing(path.to_string());
    }
    CursorCwd::Missing(path.to_string())
}

/// Where a composer should sit on the deck.
///
/// Folder sessions (git or not) group under that folder. Multi-root workspaces
/// group under the first folder in the `.code-workspace` file (or its parent).
/// The Agents window (`empty-window` / no uri) groups under "Cursor".
fn cursor_resolve_cwd(
    workspace_id: &str,
    value: &Value,
    folders: &HashMap<String, String>,
) -> CursorCwd {
    let from_value = value
        .get("workspaceIdentifier")
        .and_then(cursor_path_from_workspace_identifier);
    let from_map = folders.get(workspace_id).cloned();
    let path = from_value.or(from_map).unwrap_or_default();
    if path.is_empty() {
        return CursorCwd::Agents;
    }
    cursor_resolve_path_to_cwd(&path)
}

fn cursor_user_message_text(v: &Value) -> Option<String> {
    if v.get("role").and_then(|x| x.as_str()) != Some("user") {
        return None;
    }
    let msg = v.get("message")?;
    if let Some(s) = msg.as_str() {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if let Some(s) = msg.get("content").and_then(|x| x.as_str()) {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if let Some(arr) = msg.get("content").and_then(|x| x.as_array()) {
        for part in arr {
            if part.get("type").and_then(|x| x.as_str()) == Some("text") {
                if let Some(t) = part.get("text").and_then(|x| x.as_str()) {
                    let t = t.trim();
                    if !t.is_empty() {
                        return Some(t.to_string());
                    }
                }
            }
        }
    }
    None
}

/// First real user prompt in a Cursor agent transcript (plain text or `<user_query>`).
fn cursor_prompt_from_transcript(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(raw) = cursor_user_message_text(&v) else {
            continue;
        };
        if let Some(q) = extract_xml_tag_text(&raw, "user_query") {
            if !q.is_empty() {
                return Some(q);
            }
        }
        if raw.starts_with("<timestamp>") {
            continue;
        }
        return Some(raw);
    }
    None
}

fn cursor_first_prompt(composer_id: &str) -> Option<String> {
    let cursor_home = home_dir().join(".cursor").join("projects");
    let Ok(projects) = fs::read_dir(&cursor_home) else {
        return None;
    };
    for proj in projects.flatten() {
        let transcript = proj
            .path()
            .join("agent-transcripts")
            .join(composer_id)
            .join(format!("{}.jsonl", composer_id));
        if !transcript.exists() {
            continue;
        }
        let Ok(f) = fs::File::open(&transcript) else {
            continue;
        };
        let reader = std::io::BufReader::new(f);
        let mut acc = String::new();
        for (i, line) in reader.lines().map_while(Result::ok).enumerate() {
            if i >= 200 {
                break;
            }
            acc.push_str(&line);
            acc.push('\n');
        }
        if let Some(p) = cursor_prompt_from_transcript(&acc) {
            return Some(p);
        }
    }
    None
}

/// Composer name, else first user prompt, else subtitle. Never `SESSION xxxxxx`
/// (`sanitize_title` rejects the word "cursor", so the last resort bypasses it).
fn cursor_card_title(name: Option<&str>, prompt: Option<&str>, subtitle: Option<&str>) -> String {
    if let Some(t) = name.and_then(sanitize_title) {
        return t;
    }
    for fb in [prompt, subtitle] {
        if let Some(p) = fb.and_then(sanitize_title) {
            let words: Vec<&str> = p.split_whitespace().take(6).collect();
            if !words.is_empty() {
                return words.join(" ");
            }
        }
    }
    CURSOR_AGENTS_CWD.to_string()
}

fn cursor_composer_display_title(id: &str, composer: &Value) -> String {
    let name = composer
        .get("name")
        .or_else(|| composer.get("title"))
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty());
    if let Some(t) = name.and_then(sanitize_title) {
        return t;
    }
    let prompt = cursor_first_prompt(id);
    let subtitle = composer.get("subtitle").and_then(|x| x.as_str());
    cursor_card_title(None, prompt.as_deref(), subtitle)
}

/// A blank draft or an auto-created ephemeral composer - not a session.
///
/// Measured 2026-09-15: all three Cursor chats the census reported as wrongly
/// excluded were placeholders with nothing in them. `empty-state-draft` carries
/// `isDraft: true`; the other two were `isEphemeral: true`, never updated, and
/// created in the same millisecond the Agents window opened two lanes. Each would
/// have drawn an untitled "Cursor" card with no conversation behind it.
fn cursor_composer_is_placeholder(composer: &Value) -> bool {
    let flag = |key: &str| composer.get(key).and_then(Value::as_bool).unwrap_or(false);
    let never_updated = composer.get("lastUpdatedAt").map_or(true, Value::is_null);
    flag("isDraft") || (flag("isEphemeral") && never_updated)
}

fn cursor_composer_why(
    parse_fail: bool,
    cwd: &CursorCwd,
    mtime: u64,
    now: u64,
    running: bool,
) -> &'static str {
    if parse_fail {
        return "parse failure";
    }
    if matches!(cwd, CursorCwd::Missing(_)) {
        return "folder missing";
    }
    if mtime == 0 {
        return "parse failure";
    }
    if !within_active_window(now.saturating_sub(mtime), running) {
        return "outside window";
    }
    "on deck"
}

/// Map every known Cursor workspaceId to the folder (or `.code-workspace` file)
/// it was opened on. The NEW schema stores a workspaceId HASH on each composer,
/// not a path, so this lookup attributes a session when the composer JSON itself
/// has no `workspaceIdentifier.uri.fsPath`.
fn cursor_workspace_folders() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(root) = cursor_workspace_storage_dir() else {
        return map;
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return map;
    };
    for entry in entries.flatten() {
        let id = entry.file_name().to_string_lossy().to_string();
        let file = entry.path().join("workspace.json");
        let Ok(body) = std::fs::read_to_string(&file) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&body) else {
            continue;
        };
        let uri = v
            .get("folder")
            .or_else(|| v.get("workspace"))
            .and_then(|x| x.as_str());
        if let Some(path) = uri.and_then(cursor_uri_to_path) {
            map.insert(id, path);
        }
    }
    map
}

/// Read Cursor's CURRENT schema: a real `composerHeaders` TABLE.
///
/// ─────────────────────────────────────────────────────────────────────────────
/// CURSOR SESSIONS COULD NEVER APPEAR ON THE DECK.
///
/// The old reader did:
///     SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'
/// and returned an empty list when that row was missing. Cursor has since moved
/// composers into their own table, so that row does not exist at all: measured
/// 2026-09-14 on the owner's machine, `composer.composerHeaders` is ABSENT while
/// `composerHeaders` holds 113 rows (73 unarchived). Every Cursor session was
/// dropped on the floor, silently, by an `Err(_) => return vec![]`.
///
/// He was right every time, and no window or filter setting could ever have made them appear.
///
/// The old blob form is still read as a fallback so an older Cursor keeps working.
/// ─────────────────────────────────────────────────────────────────────────────
fn cursor_rows_from_table(
    conn: &rusqlite::Connection,
) -> Option<Vec<(String, String, u64, Value)>> {
    // Absent table => older Cursor => let the caller fall back to the blob.
    let has_table: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='composerHeaders'",
            [],
            |r| r.get(0),
        )
        .ok()?;
    if has_table == 0 {
        return None;
    }

    let mut stmt = conn
        .prepare(
            "SELECT composerId, workspaceId, \
                    COALESCE(lastUpdatedAt, recency, createdAt, 0), \
                    COALESCE(isArchived, 0), value \
             FROM composerHeaders \
             WHERE COALESCE(isArchived, 0) = 0",
        )
        .ok()?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                r.get::<_, i64>(2)?.max(0) as u64,
                r.get::<_, Option<String>>(4)?.unwrap_or_default(),
            ))
        })
        .ok()?;

    let mut out = Vec::new();
    for row in rows.flatten() {
        let (id, workspace_id, ts, raw) = row;
        let value = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
        out.push((id, workspace_id, ts, value));
    }
    Some(out)
}

/// 7-day census window used by `live_cursor_census_print` (matches the deck's 7D option).
const CURSOR_CENSUS_WINDOW_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// Heuristic: Cursor timestamps are epoch ms (~1.7e12 in 2026). Real unix
/// seconds sit in `[1e9, 1e12)` (2001–2286). Smaller values are the synthetic
/// ms clocks used in tests; larger values are already ms.
fn cursor_timestamp_unit(raw: u64) -> &'static str {
    if raw == 0 {
        "missing"
    } else if (1_000_000_000..1_000_000_000_000).contains(&raw) {
        "s"
    } else {
        "ms"
    }
}

fn cursor_normalize_timestamp(raw: u64) -> u64 {
    match cursor_timestamp_unit(raw) {
        "s" => raw.saturating_mul(1000),
        _ => raw,
    }
}

/// Live diagnostic for `live_cursor_census_print`. Uses the SAME inclusion rules
/// `cursor_sessions` uses, plus the 7-day print filter the packet asked for.
fn cursor_live_census_lines(now: u64) -> Vec<String> {
    let mut lines = Vec::new();
    let Some(db_path) = cursor_db_path() else {
        lines.push("no state.vscdb".into());
        return lines;
    };
    let uri = format!(
        "file:{}?immutable=1",
        db_path.to_string_lossy().replace('\\', "/")
    );
    let conn = match rusqlite::Connection::open_with_flags(
        &uri,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    ) {
        Ok(c) => c,
        Err(e) => {
            lines.push(format!("db open failed: {e}"));
            return lines;
        }
    };

    let folders = cursor_workspace_folders();
    let mut stmt = match conn.prepare(
        "SELECT composerId, workspaceId, \
                COALESCE(lastUpdatedAt, recency, createdAt, 0), \
                lastUpdatedAt, \
                COALESCE(isArchived, 0), value \
         FROM composerHeaders",
    ) {
        Ok(s) => s,
        Err(e) => {
            lines.push(format!("query failed: {e}"));
            return lines;
        }
    };
    let rows = match stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            r.get::<_, i64>(2)?.max(0) as u64,
            r.get::<_, Option<i64>>(3)?.unwrap_or(0).max(0) as u64,
            r.get::<_, i64>(4)?,
            r.get::<_, Option<String>>(5)?.unwrap_or_default(),
        ))
    }) {
        Ok(rs) => rs,
        Err(e) => {
            lines.push(format!("rows failed: {e}"));
            return lines;
        }
    };

    let mut printed = 0u32;
    let mut on_deck = 0u32;
    for row in rows.flatten() {
        let (id, workspace_id, coalesced, last_updated_col, archived, raw) = row;
        let (value, parse_fail) = match serde_json::from_str::<Value>(&raw) {
            Ok(v) => (v, false),
            Err(_) => (Value::Null, !raw.is_empty()),
        };
        let value_mtime = cursor_composer_mtime(&value);
        let raw_ts = if last_updated_col > 0 {
            last_updated_col
        } else if coalesced > 0 {
            coalesced
        } else {
            value_mtime
        };
        let unit = cursor_timestamp_unit(raw_ts);
        let mtime = cursor_normalize_timestamp(raw_ts).max(value_mtime);
        let in_seven_days = mtime > 0 && now.saturating_sub(mtime) <= CURSOR_CENSUS_WINDOW_MS;
        if archived != 0 || !in_seven_days {
            continue;
        }

        let name = value
            .get("name")
            .or_else(|| value.get("title"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let mode = value
            .get("unifiedMode")
            .and_then(|x| x.as_str())
            .unwrap_or("-")
            .to_string();
        let wi_fs = value
            .pointer("/workspaceIdentifier/uri/fsPath")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        let cwd = cursor_resolve_cwd(&workspace_id, &value, &folders);
        let folder = cursor_cwd_path(&cwd).unwrap_or_default();
        let why = if archived != 0 {
            "archived"
        } else if cursor_composer_is_placeholder(&value) {
            "blank draft"
        } else {
            let prev = active_window_ms();
            ACTIVE_WINDOW.store(
                CURSOR_CENSUS_WINDOW_MS,
                std::sync::atomic::Ordering::Relaxed,
            );
            let w = cursor_composer_why(parse_fail, &cwd, mtime, now, false);
            ACTIVE_WINDOW.store(prev, std::sync::atomic::Ordering::Relaxed);
            w
        };
        if why == "on deck" {
            on_deck += 1;
        }

        printed += 1;
        lines.push(format!(
            "id={} name={:?} folder={:?} workspaceId={:?} valueFsPath={:?} lastUpdatedAt={} unit={} mode={} why={}",
            id, name, folder, workspace_id, wi_fs, raw_ts, unit, mode, why
        ));
    }
    lines.push(format!(
        "census_unarchived_printed={printed} on_deck={on_deck} active_window_ms={} now={now}",
        active_window_ms()
    ));
    lines
}

fn cursor_sessions(_tracked: &HashSet<String>, now: u64) -> Vec<CursorSession> {
    let Some(db_path) = cursor_db_path() else {
        return vec![];
    };

    // WAL mtime is the process-level heartbeat for "Cursor is running"
    let wal_fresh = cursor_wal_path()
        .and_then(|p| mtime_ms(&p))
        .map(|m| now.saturating_sub(m) < LIVE_MS)
        .unwrap_or(false);
    let process_alive = cursor_process_alive();

    // Read-only WAL-aware snapshot: immutable=1 would ignore new conversations
    // until Cursor checkpoints its WAL, making RELOAD appear ineffective.
    let conn = match rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let _ = conn.busy_timeout(std::time::Duration::from_millis(200));

    // CURRENT schema first (a real `composerHeaders` table), then the old
    // ItemTable blob for an older Cursor. See `cursor_rows_from_table`.
    let table_rows = cursor_rows_from_table(&conn);
    let folders = cursor_workspace_folders();

    // Normalise BOTH shapes to (id, workspace_id, mtime, value).
    let composers: Vec<(String, String, u64, Value)> = match table_rows {
        Some(rows) => rows,
        None => {
            let raw: String = match conn.query_row(
                "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'",
                [],
                |row| row.get(0),
            ) {
                Ok(v) => v,
                Err(_) => return vec![],
            };
            let Ok(root) = serde_json::from_str::<Value>(&raw) else {
                return vec![];
            };
            let Some(all) = root.get("allComposers").and_then(|x| x.as_array()) else {
                return vec![];
            };
            all.iter()
                .filter(|c| {
                    !c.get("isArchived")
                        .and_then(|x| x.as_bool())
                        .unwrap_or(false)
                })
                .filter_map(|c| {
                    let id = c.get("composerId").and_then(|x| x.as_str())?.to_string();
                    let workspace_id = c
                        .pointer("/workspaceIdentifier/id")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    Some((id, workspace_id, cursor_composer_mtime(c), c.clone()))
                })
                .collect()
        }
    };

    let mut out: Vec<CursorSession> = vec![];

    for (id, workspace_id, raw_ts, composer) in composers {
        let composer = &composer;
        let mtime = cursor_normalize_timestamp(raw_ts).max(cursor_composer_mtime(composer));
        let bubble_count = cursor_bubble_count(&conn, &id, composer);
        let cwd = cursor_resolve_cwd(&workspace_id, composer, &folders);
        let fspath = match &cwd {
            CursorCwd::Missing(path) => path.clone(),
            _ => cursor_cwd_path(&cwd).unwrap_or_else(|| CURSOR_AGENTS_CWD.to_string()),
        };
        // Untracked folders still show: grouped under the folder the way Codex
        // sessions in untracked dirs already do. `tracked` is intentionally ignored.

        let title = Some(cursor_composer_display_title(&id, composer));

        let is_agent = composer
            .get("unifiedMode")
            .and_then(|x| x.as_str())
            .map(|m| m == "agent")
            .unwrap_or(false);
        let transcript_in_flight = is_agent && cursor_transcript_in_flight(&id);
        let running = cursor_composer_is_running(
            now,
            mtime,
            process_alive,
            wal_fresh,
            is_agent,
            transcript_in_flight,
        );
        let mutable = cursor_composer_is_mutable_agent(composer);
        out.push(CursorSession {
            bubble_count,
            id,
            cwd: fspath,
            title,
            model: None,
            mtime,
            running,
            mutable,
        });
    }

    out
}

// ── Fold Codex + Cursor sessions into the snapshot ───────────────────────────
//
// Both tools are surfaced as synthetic Lane + SessionCard entries: one Lane per
// (tool, cwd) pair, with driver "codex" / "cursor". They are attached to the
// same Repo group as Claude sessions for the same cwd (via git_resolve_repo),
// so the Flight Deck shows them as extra lanes on the same repo card.

/// Is a Codex/Cursor session actually WORKING, or is its app merely open?
///
/// ─────────────────────────────────────────────────────────────────────────────
/// `running` for these two tools means THE APPLICATION IS OPEN. Not that a prompt is executing.
///
/// The Claude path already solved this: alive AND its last turn still open AND
/// that turn recent. Codex rollouts and Cursor sessions carry no turn model, but
/// they DO carry an mtime - the tool rewrites the session file as it works. So a
/// file untouched for half an hour is not a prompt in flight, whatever the process
/// table says. Same 30-minute bound the Claude lane uses, so one definition of
/// "working" holds across all three tools.
///
/// This is deliberately conservative in the honest direction: it can call a very
/// slow single turn "not working", which under-claims. The old rule over-claimed,
/// and an agent orbiting for work nobody is doing is the failure the owner actually
/// reported.
/// ─────────────────────────────────────────────────────────────────────────────
fn tool_session_working(running: bool, age: u64) -> bool {
    running && age < WORKING_STALE_MS
}

/// Status for a Codex/Cursor card, mirroring the Claude lane's three rungs:
/// executing now / open but idle / gone.
fn tool_session_status(running: bool, age: u64) -> String {
    if tool_session_working(running, age) {
        "live"
    } else if running {
        // Open, but not executing. It still belongs on the deck - it just must
        // not read as, or orbit like, active work.
        "recent"
    } else {
        liveness(age)
    }
    .to_string()
}

fn codex_session_to_card(s: &CodexSession, now: u64) -> SessionCard {
    let age = now.saturating_sub(s.mtime);
    let status = tool_session_status(s.running, age);
    let model_label = s.model.as_deref().and_then(pretty_model);
    SessionCard {
        owner: s.owner,
        activity: if tool_session_working(s.running, age) {
            "running"
        } else {
            "active"
        }
        .into(),
        cwd: s.cwd.clone(),
        id: format!("codex:{}", s.id),
        title: card_title(s.title.as_deref(), None, &s.id),
        status,
        age_ms: age,
        mtime: s.mtime,
        model: s.model.clone(),
        model_label,
        effort: None,
        preview: None,
        branch: None,
        running: s.running,
        // The reader already checked process liveness AND an unmatched turn.
        working: tool_session_working(s.running, age),
        origin: "manual".to_string(), // codex rollouts carry no spawn pid to match
        pid: None,                    // codex has no pid registry to stop from
        role: "build".to_string(),    // Codex always edits files
        wants: None,                  // headless codex never sits on an approval gate
    }
}

fn cursor_session_to_card(s: &CursorSession, now: u64) -> SessionCard {
    let age = now.saturating_sub(s.mtime);
    let status = tool_session_status(s.running, age);
    SessionCard {
        owner: cursor_owner(s.bubble_count),
        activity: if tool_session_working(s.running, age) {
            "running"
        } else {
            "active"
        }
        .into(),
        cwd: s.cwd.clone(),
        id: format!("cursor:{}", s.id),
        title: s
            .title
            .clone()
            .or_else(|| Some(CURSOR_AGENTS_CWD.to_string())),
        status,
        age_ms: age,
        mtime: s.mtime,
        model: None,
        model_label: None,
        effort: None,
        preview: None,
        branch: None,
        running: s.running,
        // The reader already checked process liveness AND an unmatched turn.
        working: tool_session_working(s.running, age),
        origin: "manual".to_string(), // cursor composers carry no spawn pid to match
        pid: None, // cursor composers are threads in the IDE, not stoppable processes
        role: if s.mutable { "build" } else { "passive" }.to_string(),
        wants: None, // cursor composer isn't a headless gate we can read
    }
}

fn has_builder_collision(live_builders: u32, read_only: bool, mission_control: bool) -> bool {
    live_builders >= 2 && !read_only && !mission_control
}

// ── Snapshot cache - ONE build serves every window ───────────────────────────
// The old fd_sessions rebuilt the whole snapshot per call, per window; a cold
// build (30 worktrees × 2-3 git spawns) measured 42s on real data - the deck sat
// dark that whole time. Now: a fresh cached snapshot returns instantly; a stale
// one is served immediately while ONE background rebuild runs and pushes
// praxis://fd-update when it lands (every listening window re-pulls the fresh
// cache); a truly cold process does one FAST build (no git-diff shells) so
// sessions are on screen in ~a second, then warms diffs in the background.
fn snap_cache() -> &'static Mutex<Option<Snapshot>> {
    static C: OnceLock<Mutex<Option<Snapshot>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

fn cold_build_lock() -> &'static Mutex<()> {
    static C: OnceLock<Mutex<()>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(()))
}
static SNAP_STALE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Default)]
struct RebuildState {
    in_flight: bool,
    started_ms: u64,
    generation: u64,
}

static REBUILD_STATE: Mutex<RebuildState> = Mutex::new(RebuildState {
    in_flight: false,
    started_ms: 0,
    generation: 0,
});

fn cached_snapshot(max_age_ms: u64, now: u64) -> Option<Snapshot> {
    let guard = snap_cache().lock().ok()?;
    let snap = guard.as_ref()?;
    if now.saturating_sub(snap.generated_at) <= max_age_ms {
        Some(snap.clone())
    } else {
        None
    }
}

fn store_snapshot(snap: &Snapshot) {
    if let Ok(mut guard) = snap_cache().lock() {
        // A presumed-hung rebuild that eventually finishes carries an OLD view of
        // the world. It must not replace a newer snapshot a later rebuild stored.
        if guard
            .as_ref()
            .is_some_and(|cur| cur.generated_at > snap.generated_at)
        {
            return;
        }
        *guard = Some(snap.clone());
    }
    SNAP_STALE.store(false, std::sync::atomic::Ordering::Relaxed);
}

/// Mark the cache stale so the next poll rebuilds promptly - called after any
/// mutation that changes what the deck should show (spawn/stop/lane lock).
fn invalidate_snapshot_cache() {
    SNAP_STALE.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// A rebuild still "in flight" after this long is presumed dead, and a new one may
/// start. One diff refresh can spend up to three sequential `GIT_TIMEOUT`s for each
/// lane admitted by `DIFF_SHELL_BUDGET`, before the bounded session scan is counted.
/// Keep the lease above that real worst-case envelope: a 90-second lease caused
/// healthy-but-slow rebuilds to overlap, multiplying disk load and repeatedly
/// reporting the recovery path as a backend error.
const REBUILD_LEASE_MS: u64 = 5 * 60_000;
/// A stale lease older than this most likely spanned sleep/standby (polls stop while
/// windows are hidden and the machine sleeps), so it is logged as info, not an error.
const STANDBY_SUSPECT_MS: u64 = 15 * 60_000;

/// Releases the in-flight flag when the rebuild thread ends - by returning OR by
/// PANICKING, since Drop runs during unwinding. Only the rebuild that still owns
/// the current generation may release it, so a presumed-dead thread that finally
/// finishes cannot clear the flag of the rebuild that replaced it.
struct RebuildLease {
    gen: u64,
}

impl Drop for RebuildLease {
    fn drop(&mut self) {
        let mut state = REBUILD_STATE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.generation == self.gen {
            state.in_flight = false;
            state.started_ms = 0;
        }
    }
}

/// Atomically claim the one process-wide rebuild slot. The former three-atomic
/// sequence let two window polls both observe `false`; the later generation could
/// finish before the earlier caller finally stored `true`, leaving a flag that no
/// generation was allowed to clear. That exact lost-clear race froze the cache for
/// hours even though every individual snapshot build completed normally.
fn claim_rebuild(now: u64, force: bool) -> Option<(RebuildLease, Option<u64>)> {
    let mut state = REBUILD_STATE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut stale_for = None;
    if state.in_flight {
        let elapsed = now.saturating_sub(state.started_ms);
        if !force && elapsed < REBUILD_LEASE_MS {
            return None;
        }
        if !force {
            stale_for = Some(elapsed);
        }
    }
    state.generation = state.generation.wrapping_add(1).max(1);
    state.started_ms = now;
    state.in_flight = true;
    Some((
        RebuildLease {
            gen: state.generation,
        },
        stale_for,
    ))
}

/// Restore: mark the cache stale and start a rebuild NOW, overriding any lease.
///
/// The ordinary path deliberately defers to an in-flight rebuild; Restore exists
/// precisely for the case where that deference is wrong, so it takes over.
pub(crate) fn force_fresh_snapshot(app: tauri::AppHandle) {
    invalidate_snapshot_cache();
    clear_codex_meta_cache();
    spawn_snapshot_rebuild_with(app, true);
}

/// Kick ONE background full rebuild (dedup'd), with a guard that cannot latch.
///
/// The old guard was `swap(true)` then `store(false)` at the end of the thread. A
/// rebuild that panicked never reached the store, and one that hung never finished,
/// so the flag stayed true for the rest of the process: every poll served the last
/// cached snapshot and every new rebuild was skipped as a duplicate. Sessions ended
/// and kept orbiting; archived sessions stayed on the deck; the fix was always
/// "restart the app". Now the flag is released on unwind, and a lease older than
/// REBUILD_LEASE_MS is taken over instead of obeyed.
fn spawn_snapshot_rebuild(app: tauri::AppHandle) {
    spawn_snapshot_rebuild_with(app, false);
}

fn spawn_snapshot_rebuild_with(app: tauri::AppHandle, force: bool) {
    let now = now_ms();
    let Some((lease, stale_for)) = claim_rebuild(now, force) else {
        return; // a live rebuild is already on it
    };
    if let Some(elapsed) = stale_for {
        // A lease hours old is almost never a hang: the wall clock kept running while the
        // PC sat in Modern Standby. All three "hung for 5-6.5 h" errors of 10-02..10-04
        // began within a second of standby entry (Kernel-Power 506) and were reported
        // seconds after wake (507). Taking over is still right either way; only a lease
        // that went stale while the machine was awake is worth an error.
        if elapsed > STANDBY_SUSPECT_MS {
            crate::dlog!(
                "[flightdeck] snapshot rebuild lease {}s old (spanned sleep/standby) - starting a fresh one",
                elapsed / 1000
            );
        } else {
            crate::elog!(
                "[flightdeck] snapshot rebuild in flight for {}s - presumed hung, starting a fresh one",
                elapsed / 1000
            );
        }
    }
    let overrides = read_only_overrides(&app);
    std::thread::spawn(move || {
        let _lease = lease;
        let snap = build_snapshot_with(&overrides, true);
        store_snapshot(&snap);
        // Every window's fd-update listener re-polls and hits the fresh cache.
        let _ = app.emit(
            "praxis://fd-update",
            serde_json::json!({ "kind": "snapshot" }),
        );
    });
}

// ── Public commands ──────────────────────────────────────────────────────────
#[tauri::command]
pub async fn fd_sessions(app: tauri::AppHandle) -> Snapshot {
    let now = now_ms();
    // Honour a window change made in ANOTHER window before serving from cache.
    load_active_window(&app);
    // 1. Fresh cache (and not invalidated by a mutation) → instant.
    if !SNAP_STALE.load(std::sync::atomic::Ordering::Relaxed) {
        if let Some(snap) = cached_snapshot(SNAP_FRESH_MS, now) {
            return snap;
        }
    }
    // 2. ANY cached snapshot → serve it immediately, refresh in the background;
    //    praxis://fd-update pulls every window forward when the rebuild lands.
    if let Some(snap) = cached_snapshot(u64::MAX, now) {
        spawn_snapshot_rebuild(app);
        return snap;
    }
    // 3. Cold start (first call in this process): fast build WITHOUT git-diff
    //    shells so the fleet paints in ~a second. build_snapshot_with does
    //    blocking FS + subprocess work - spawn_blocking keeps IPC alive. Multiple
    //    windows can arrive before the first snapshot lands, so serialize this path
    //    and let followers consume the cache instead of multiplying the census.
    let overrides = read_only_overrides(&app);
    let snap = tokio::task::spawn_blocking(move || {
        let _cold = cold_build_lock()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(snap) = cached_snapshot(u64::MAX, now_ms()) {
            return snap;
        }
        let snap = build_snapshot_with(&overrides, false);
        if snap.error.is_none() {
            store_snapshot(&snap);
        }
        snap
    })
        .await
        .unwrap_or_else(|_| Snapshot {
            generated_at: 0,
            projects_dir: String::new(),
            repos: vec![],
            groups: vec![],
            active_window_ms: active_window_ms(),
            hidden_older: 0,
            hidden_other_account: 0,
            hidden_accounts: vec![],
            hidden_subagents: 0,
            hidden_probes: 0,
            hidden_praxis: 0,
            hidden_automation: 0,
            hidden_placeholders: 0,
            active_count: 0,
            running_count: 0,
            read_only_lanes: vec![],
            error: Some("snapshot thread panicked".into()),
        });
    if snap.error.is_none() {
        // Warm the diff chips + take over future polls.
        spawn_snapshot_rebuild(app);
    }
    snap
}

/// The last `n` (≤20) MEANINGFUL lines of a session's transcript, newest-first,
/// as short display strings ("✎ Edit foo.rs", "▸ Bash cargo check", "❯ <prompt>").
/// Reads only the on-disk transcript tail - never touches the live process. Claude
/// sessions parse the ~/.claude/projects JSONL (same locator as the deck preview);
/// codex/cursor have no readable per-session transcript here yet → empty (the deck
/// falls back to the snapshot preview line). Runs on the blocking pool like
/// fd_sessions so it never stalls IPC.
#[tauri::command]
pub async fn fd_session_tail(
    session_id: String,
    cwd: String,
    driver: String,
    n: usize,
) -> Vec<String> {
    tokio::task::spawn_blocking(move || build_session_tail(&session_id, &cwd, &driver, n))
        .await
        .unwrap_or_default()
}

fn build_session_tail(session_id: &str, cwd: &str, driver: &str, n: usize) -> Vec<String> {
    let n = n.clamp(1, 20);
    match driver {
        // Codex/Cursor have no readable transcript - but a session PRAXIS spawned
        // streams to a real log at fd-sessions/<id>.log, so tail that. Without it
        // the console showed one frozen snapshot line under a pulsing "LIVE TAIL"
        // dot and a 5s poll that always returned nothing.
        "codex" | "cursor" => spawn_log_tail(session_id, n),
        _ => claude_session_tail(session_id, cwd, n),
    }
}

/// Last `n` non-empty lines of a Praxis-spawned session's log, newest-first.
/// Empty for a session Praxis did not spawn (no log exists) - the client then
/// labels the block LAST SEEN instead of claiming a live tail.
fn spawn_log_tail(session_id: &str, n: usize) -> Vec<String> {
    let Some(dir) = crate::praxis_dir() else {
        return vec![];
    };
    let path = dir
        .join("fd-sessions")
        .join(format!("{}.log", session_id.trim()));
    let Ok(bytes) = read_tail_bytes(&path, TAIL_BYTES) else {
        return vec![];
    };
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<String> = text
        .lines()
        .skip(1) // the first line of a byte-tail is probably partial
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| {
            // Codex --json emits one JSON object per line; show its message when
            // there is one, else the raw line.
            serde_json::from_str::<Value>(l)
                .ok()
                .and_then(|v| {
                    v.get("message")
                        .or_else(|| v.get("text"))
                        .or_else(|| v.get("content"))
                        .and_then(|x| x.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| l.to_string())
        })
        .map(|l| {
            let t: String = l.split_whitespace().collect::<Vec<_>>().join(" ");
            if t.chars().count() > PREVIEW_MAX {
                format!("{}…", t.chars().take(PREVIEW_MAX - 1).collect::<String>())
            } else {
                t
            }
        })
        .collect();
    lines.reverse(); // newest-first, matching claude_session_tail
    lines.truncate(n);
    lines
}

fn claude_session_tail(session_id: &str, cwd: &str, n: usize) -> Vec<String> {
    if cwd.trim().is_empty() {
        return vec![];
    }
    let file = projects_dir()
        .join(encode_cwd(cwd))
        .join(format!("{}.jsonl", session_id.trim()));
    let Ok(bytes) = read_tail_bytes(&file, TAIL_BYTES) else {
        return vec![];
    };
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.split('\n').filter(|l| !l.trim().is_empty()).collect();
    // Drop the (likely partial) first line from the seek offset.
    if lines.len() > 1 {
        lines.remove(0);
    }
    let mut out: Vec<String> = vec![];
    for line in lines.iter() {
        let Ok(o) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let typ = o.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let Some(m) = o.get("message") else { continue };
        if typ == "assistant" {
            if let Some(c) = m.get("content").and_then(|x| x.as_array()) {
                for b in c {
                    match b.get("type").and_then(|x| x.as_str()) {
                        Some("text") => {
                            if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                                if let Some(cl) = clean(t) {
                                    out.push(cl);
                                }
                            }
                        }
                        Some("tool_use") => {
                            if let Some(name) = b.get("name").and_then(|x| x.as_str()) {
                                out.push(describe_tool_use(name, b.get("input")));
                            }
                        }
                        _ => {}
                    }
                }
            }
        } else if typ == "user" {
            // A real operator prompt (string content) is a meaningful tail line;
            // tool_result arrays are noise and skipped.
            if let Some(s) = m.get("content").and_then(|x| x.as_str()) {
                if let Some(cl) = clean(s) {
                    out.push(format!("❯ {cl}"));
                }
            }
        }
    }
    // Newest activity first (peeks[0] is the headline line in the deck), capped at n.
    out.reverse();
    out.truncate(n);
    out
}

/// Pure scan (no Tauri handle) so it can be exercised in tests against real
/// local Claude state. `overrides` = lane ids the user marked read-only.
/// `allow_diff_shell = false` is the COLD-START fast path: the whole fleet
/// (sessions/lanes/repos) is scanned but no git diff subprocess is spawned, so
/// a freshly-opened deck paints in ~a second. The background full build that
/// follows (see fd_sessions) fills the diff chips and pushes praxis://fd-update.
pub fn build_snapshot_with(overrides: &HashSet<String>, allow_diff_shell: bool) -> Snapshot {
    let now = now_ms();
    // These adapters are independent and each may take several seconds on a real
    // Windows machine (tasklist, Cursor's WAL, Codex rollouts, git worktrees).
    // Running them serially made the cold "fast" path their sum (~10s even after
    // filtering old Codex files). Run them together so first paint pays only the
    // slowest truthful census, not every provider one after another.
    let (mut recs, running, spawned, codex, cursor, projects) = std::thread::scope(|scope| {
        let recs_task = scope.spawn(read_records);
        let running_task = scope.spawn(running_pids);
        let spawned_task = scope.spawn(spawned_pids);
        let codex_task = scope.spawn(|| codex_sessions(&HashSet::new(), now));
        let cursor_task = scope.spawn(|| cursor_sessions(&HashSet::new(), now));
        let projects_task = scope.spawn(|| project_registry(false));
        (
            recs_task.join().unwrap_or_default(),
            running_task.join().unwrap_or_default(),
            spawned_task.join().unwrap_or_default(),
            codex_task.join().unwrap_or_default(),
            cursor_task.join().unwrap_or_default(),
            projects_task.join().unwrap_or_default(),
        )
    });
    // ── Praxis-spawned sessions that the desktop store has never heard of ────
    //
    // The store under %APPDATA%\Claude\claude-code-sessions is written by the
    // Claude DESKTOP app. A headless session Praxis launches (`claude -p`) never
    // appears in it - verified live: a spawn registered a pid and a session id in
    // ~/.claude/sessions, and no store record was ever written. Since the Claude
    // pass iterates store records, a session Praxis started could not get a card
    // AT ALL, which is the real reason the agent columns read 0 LIVE. Marking a
    // card's origin was necessary but not sufficient; the card has to exist.
    //
    // So: synthesize a record for every live spawn the store is missing. The join
    // is the pid, from Claude's own session registry.
    {
        let known: HashSet<&str> = recs.iter().map(|r| r.cli_session_id.as_str()).collect();
        let pid_to_session: HashMap<u32, String> =
            running.iter().map(|(sid, pid)| (*pid, sid.clone())).collect();
        let mut extra: Vec<Record> = vec![];
        for rec in read_spawned_records() {
            let Some(session_id) = pid_to_session.get(&rec.pid) else {
                continue; // process gone, or not registered (yet)
            };
            if known.contains(session_id.as_str()) {
                continue; // the store knows it - the normal path already has it
            }
            extra.push(Record {
                cli_session_id: session_id.clone(),
                cwd: rec.cwd.clone(),
                title: None, // the transcript tail supplies a real preview/title
                model: None,
                effort: None,
                is_archived: false,
                last_activity_at: rec.spawned_at,
                account: String::new(),
            });
        }
        if !extra.is_empty() {
            crate::dlog!(
                "[fd] surfacing {} praxis-spawned session(s) absent from the desktop store",
                extra.len()
            );
            recs.extend(extra);
        }
    }
    let recs = recs;
    // The pid map, not just the id set: SessionCard carries the live pid so the
    // deck's STOP control is reachable (see SessionCard::pid).
    let proj = projects_dir();
    let mut diff_budget: i32 = if allow_diff_shell {
        DIFF_SHELL_BUDGET
    } else {
        0
    };

    // Group VISIBLE records by cwd; count what each filter removed, separately, so
    // the deck can report it honestly instead of silently showing fewer cards.
    // See the VISIBILITY RULE block at the top of this file for the full rationale.
    let accounts = current_account_keys(&recs, now);
    let ledger = read_account_ledger();
    let mut by_cwd: HashMap<String, Vec<&Record>> = HashMap::new();
    let mut archived_by_cwd: HashMap<String, u32> = HashMap::new();

    let mut hidden_by_email: std::collections::BTreeMap<String, u32> =
        std::collections::BTreeMap::new();
    let signed_in_uuids: HashSet<String> = desktop_account_uuid()
        .into_iter()
        .chain(signed_in_account().and_then(|(key, _)| key.split('/').next().map(str::to_string)))
        .filter(|u| !u.is_empty())
        .collect();
    let window = active_window_ms();
    let mut claude_off_sidebar_older: u32 = 0;
    for r in &recs {
        if r.is_archived {
            *archived_by_cwd.entry(r.cwd.clone()).or_insert(0) += 1;
            continue;
        }
        if !accounts.contains(&r.account) {
            let email = email_for_account_key(&r.account, &ledger);
            *hidden_by_email.entry(email).or_insert(0) += 1;
            continue;
        }
        if claude_record_outside_window(r, &signed_in_uuids, window, now, &running) {
            claude_off_sidebar_older += 1;
            continue;
        }
        by_cwd.entry(r.cwd.clone()).or_default().push(r);
    }
    let hidden_accounts: Vec<HiddenAccount> = hidden_by_email
        .into_iter()
        .map(|(email, count)| HiddenAccount { email, count })
        .collect();
    let hidden_other_account: u32 = hidden_accounts.iter().map(|h| h.count).sum();

    let mut cards = vec![];
    for (cwd, group) in by_cwd {
        cards.extend(build_lane_bundle(&cwd, group, &running, &spawned, &proj, now).cards);
    }
    cards.extend(
        codex
            .sessions
            .iter()
            .map(|s| codex_session_to_card(s, now)),
    );
    cards.extend(
        cursor
            .iter()
            .map(|s| cursor_session_to_card(s, now)),
    );
    let paths = OwnerPaths::new(
        &home_dir().to_string_lossy(),
        &std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
            home_dir()
                .join("AppData/Local")
                .to_string_lossy()
                .into_owned()
        }),
    );
    let routed = route_sessions(cards, &projects, &paths, active_window_ms());
    let mut accum = routed.accum;
    for (cwd, count) in archived_by_cwd {
        if let Some((project, wt)) = project_lane(&projects, &cwd) {
            if let Some(ra) = accum.get_mut(&project.key) {
                *ra.archived.entry(norm_path(&wt.path)).or_default() += count;
            }
        }
    }

    // Materialize repos → lanes.
    let mut repos: Vec<Repo> = vec![];
    for (_, mut ra) in accum {
        let has_fleet = ra.info.worktrees.len() > 1 || ra.info.specs.iter().any(|s| s.remote);
        let mut lanes: Vec<Lane> = vec![];

        // The repo's base/integration branch = the main worktree's branch. Each lane's
        // diff is its divergence from this (a fleet's lanes all merge back to it).
        let base_branch = ra
            .info
            .worktrees
            .first()
            .and_then(|w| w.branch.clone())
            .unwrap_or_default();

        for (i, wt) in ra.info.worktrees.iter().enumerate() {
            let is_main = i == 0;
            let wn = norm_path(&wt.path);
            let base = basename(&wt.path);
            let base_low = base.to_ascii_lowercase();
            let bundle = ra.bundles.remove(&wn);
            let archived = ra.archived.get(&wn).copied().unwrap_or(0);

            // Manifest spec for this worktree (by folder basename), if any.
            let spec = ra
                .info
                .specs
                .iter()
                .find(|s| s.folder_base.as_deref() == Some(base_low.as_str()));

            let driver = match spec {
                Some(s) => s.driver.clone(),
                None => {
                    let branch = wt.branch.clone().unwrap_or_default();
                    let mut d = classify_driver(&[&branch, &base_low]);
                    // A standalone worktree with no tool signal defaults to the
                    // neutral "claude" lane, except the main worktree of a fleet,
                    // which is the integration target.
                    if d == "claude" && is_main && has_fleet {
                        d = "integration".to_string();
                    }
                    d
                }
            };
            let is_integration = driver == "integration"
                || (is_main
                    && has_fleet
                    && !matches!(driver.as_str(), "cursor" | "codex" | "cloud"));
            let kind = if is_mission_control(&wt.path) {
                "mission-control"
            } else {
                "worktree"
            };
            let label = spec
                .map(|s| s.label.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    if is_integration {
                        "Integration".to_string()
                    } else {
                        pretty_label(&base)
                    }
                });
            let port = spec.and_then(|s| s.port);

            let auto_ro = is_background(&wt.path);
            let user_ro = overrides.contains(&encode_cwd(&wt.path));
            let read_only = auto_ro || user_ro;
            let is_mission = kind == "mission-control";

            let (live, recent, builders, cards, overflow) = match bundle {
                Some(b) => (
                    b.live_count,
                    b.recent_count,
                    b.live_builder_count,
                    b.cards,
                    b.overflow,
                ),
                None => (0, 0, 0, vec![], 0),
            };
            // Collision = 2+ live BUILD sessions in THIS working dir across ALL
            // drivers (Claude + Codex + Cursor share the census), for a writable,
            // non-mission-control lane. `builders` (Claude-only) keeps feeding
            // live_builder_count below; the census already includes it.
            let cross = builders;
            let collision = has_builder_collision(cross, read_only, is_mission);

            // Real per-lane diff vs the base branch (cached; budgeted shell-outs).
            // The main lane's base == its own branch, so its numstat is just its
            // uncommitted delta.
            let diff = lane_diff(&wt.path, &base_branch, now, &mut diff_budget);

            lanes.push(Lane {
                id: encode_cwd(&wt.path),
                label,
                path: Some(wt.path.clone()),
                branch: wt.branch.clone(),
                head: wt.head.clone(),
                driver: if is_integration {
                    "integration".to_string()
                } else {
                    driver
                },
                port,
                kind: kind.to_string(),
                is_integration,
                remote: false,
                read_only,
                auto_read_only: auto_ro,
                user_read_only: user_ro,
                background: false,
                live_count: live,
                recent_count: recent,
                archived_count: archived,
                live_builder_count: builders,
                collision,
                sessions: cards,
                overflow,
                diff,
            });
        }

        // Declared remote/cloud lanes (no local folder) from the manifest.
        for (idx, s) in ra.info.specs.iter().filter(|s| s.remote).enumerate() {
            let label = if s.label.is_empty() {
                "Cloud".to_string()
            } else {
                s.label.clone()
            };
            lanes.push(Lane {
                id: format!("{}::cloud-{}", ra.info.key, idx),
                label,
                path: None,
                branch: s.branch.clone(),
                head: None,
                driver: "cloud".to_string(),
                port: s.port,
                kind: "cloud".to_string(),
                is_integration: false,
                remote: true,
                read_only: true, // off-machine; never a local collision
                auto_read_only: true,
                user_read_only: false,
                background: false,
                live_count: 0,
                recent_count: 0,
                archived_count: 0,
                live_builder_count: 0,
                collision: false,
                sessions: vec![],
                overflow: 0,
                diff: None, // off-machine cloud lane - no local worktree to diff
            });
        }

        // Order lanes: integration first, then Max → Cursor → Codex, cloud last.
        lanes.sort_by(|a, b| {
            driver_rank(&a.driver, a.is_integration)
                .cmp(&driver_rank(&b.driver, b.is_integration))
                .then_with(|| {
                    a.label
                        .to_ascii_lowercase()
                        .cmp(&b.label.to_ascii_lowercase())
                })
                .then_with(|| a.id.cmp(&b.id))
        });

        let live_count: u32 = lanes.iter().map(|l| l.live_count).sum();
        let recent_count: u32 = lanes.iter().map(|l| l.recent_count).sum();
        let archived_count: u32 = lanes.iter().map(|l| l.archived_count).sum();
        let running_lane_count = lanes.iter().filter(|l| l.live_count > 0).count() as u32;
        let active_lane_count = lanes
            .iter()
            .filter(|l| l.live_count > 0 || l.recent_count > 0)
            .count() as u32;
        let collision = lanes.iter().any(|l| l.collision);

        // A repo is worth showing once any lane has ANY non-archived session - running,
        // recently finished, OR dormant-but-unarchived (a done task still on the deck).
        // (Archived sessions are filtered out far earlier, so anything here counts.)
        let shown_sessions: usize = lanes
            .iter()
            .map(|l| l.sessions.len() + l.overflow as usize)
            .sum();
        if shown_sessions == 0 {
            continue;
        }

        repos.push(Repo {
            id: encode_cwd(&ra.info.root),
            label: ra.info.label.clone(),
            root: ra.info.root.clone(),
            lane_count: lanes.len() as u32,
            running_lane_count,
            active_lane_count,
            live_count,
            recent_count,
            archived_count,
            collision,
            parallel: running_lane_count >= 2 && !collision,
            has_fleet,
            lanes,
        });
    }

    // STABLE order only - the deck must not reshuffle on its own as sessions go
    // live/dormant. Collisions float to the top (they need attention), then by
    // label so a repo keeps its slot across polls. The client layers the
    // operator's manual ordering on top.
    repos.sort_by(|a, b| {
        b.collision
            .cmp(&a.collision)
            .then_with(|| {
                a.label
                    .to_ascii_lowercase()
                    .cmp(&b.label.to_ascii_lowercase())
            })
            .then_with(|| a.id.cmp(&b.id))
    });

    Snapshot {
        generated_at: now,
        projects_dir: proj.to_string_lossy().into_owned(),
        repos,
        active_window_ms: active_window_ms(),
        groups: routed.groups,
        active_count: routed.active_count,
        running_count: routed.running_count,
        hidden_praxis: routed.hidden.praxis,
        hidden_automation: routed.hidden.automation,
        hidden_placeholders: routed.hidden.placeholders,
        hidden_older: routed.hidden.older + claude_off_sidebar_older + codex.hidden_older,
        hidden_other_account,
        hidden_accounts,
        hidden_subagents: routed.hidden.subagents,
        hidden_probes: routed.hidden.probes,
        read_only_lanes: {
            let mut v: Vec<String> = overrides.iter().cloned().collect();
            v.sort();
            v
        },
        error: None,
    }
}

// ── Vault (queued prompts + read-only overrides) - real user data only ────────
fn vault_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("flight-deck-vault.json"))
}

fn empty_vault() -> Value {
    serde_json::json!({ "version": 1, "lanes": {}, "config": { "readOnlyLanes": [], "laneOrder": [] } })
}

fn read_vault_value(app: &tauri::AppHandle) -> Value {
    let Some(p) = vault_path(app) else {
        return empty_vault();
    };
    let Ok(raw) = fs::read_to_string(&p) else {
        return empty_vault();
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return empty_vault();
    };
    if v.get("lanes").is_some() {
        v
    } else {
        empty_vault()
    }
}

fn read_only_overrides(app: &tauri::AppHandle) -> HashSet<String> {
    let v = read_vault_value(app);
    let mut set = HashSet::new();
    if let Some(arr) = v
        .pointer("/config/readOnlyLanes")
        .and_then(|x| x.as_array())
    {
        for it in arr {
            if let Some(s) = it.as_str() {
                set.insert(s.to_string());
            }
        }
    }
    set
}

/// Pull the persisted active window out of the vault into the process-global
/// atomic that `build_snapshot_with` reads. Called on every `fd_sessions` poll so
/// a change made in one window reaches every other window's next snapshot, and at
/// startup so the very first build already honours the owner's setting.
pub(crate) fn load_active_window(app: &tauri::AppHandle) {
    let v = read_vault_value(app);
    let ms = v
        .pointer("/config/activeWindowMs")
        .and_then(|x| x.as_u64())
        .unwrap_or(DEFAULT_ACTIVE_WINDOW_MS);
    ACTIVE_WINDOW.store(ms, std::sync::atomic::Ordering::Relaxed);
}

/// Set how far back the deck counts a session as ACTIVE. Persists to the same vault `config` the
/// read-only lane locks live in, drops the cached snapshot so the next poll rebuilds, and emits
/// `praxis://fd-update` so every open window re-polls immediately rather than waiting out its
/// interval.
#[tauri::command]
pub fn fd_set_active_window(app: tauri::AppHandle, ms: u64) -> Result<u64, String> {
    let Some(p) = vault_path(&app) else {
        return Err("no app data dir".into());
    };
    let mut existing = read_vault_value(&app);
    if !existing.is_object() {
        existing = serde_json::json!({});
    }
    if !existing
        .get("config")
        .map(|c| c.is_object())
        .unwrap_or(false)
    {
        existing["config"] = serde_json::json!({});
    }
    existing["config"]["activeWindowMs"] = serde_json::json!(ms);
    fs::write(
        &p,
        serde_json::to_string_pretty(&existing).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    ACTIVE_WINDOW.store(ms, std::sync::atomic::Ordering::Relaxed);
    SNAP_STALE.store(true, std::sync::atomic::Ordering::SeqCst);
    spawn_snapshot_rebuild(app.clone());
    let _ = app.emit(
        "praxis://fd-update",
        serde_json::json!({ "kind": "active-window", "ms": ms }),
    );
    Ok(ms)
}

/// Open a new git worktree lane on a repo - the action the Code Lanes panel has
/// been promising.
///
/// That panel renders a dashed "next lane" row captioned "opens on demand - git
/// worktree add, praxis does it", shaped exactly like the real lane rows above
/// it. It had no click handler and nothing in the deck had ever run
/// `git worktree add`: flightdeck.rs and flightdeck_topology.rs only ever READ
/// worktrees. Now it does the thing it claims.
///
/// The new worktree is created as a SIBLING of the repo (`<repo>-lanes/<letter>`,
/// the layout the owner's existing lanes already use) on a new branch off the current
/// HEAD. Refuses rather than guessing when the repo isn't a git repo, when the
/// branch already exists, or when the target directory is occupied.
#[tauri::command]
pub async fn fd_add_worktree(
    app: tauri::AppHandle,
    repo_root: String,
    letter: String,
) -> Result<String, String> {
    let letter = letter.trim().to_ascii_lowercase();
    if letter.is_empty() || !letter.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("lane letter must be alphanumeric".into());
    }
    let root = repo_root.trim().to_string();
    if root.is_empty() || !Path::new(&root).is_dir() {
        return Err(format!("repo not found: {root}"));
    }

    tauri::async_runtime::spawn_blocking(move || {
        // Confirm it is a git repo before touching anything.
        if run_git(&root, &["rev-parse", "--git-dir"]).is_none() {
            return Err(format!("not a git repo: {root}"));
        }
        let repo_path = Path::new(&root);
        let name = repo_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("repo")
            .to_string();
        let parent = repo_path
            .parent()
            .ok_or_else(|| "repo has no parent directory".to_string())?;
        let lanes_dir = parent.join(format!("{name}-lanes"));
        let target = lanes_dir.join(&letter);
        if target.exists() {
            return Err(format!("{} already exists", target.display()));
        }
        std::fs::create_dir_all(&lanes_dir)
            .map_err(|e| format!("could not create {}: {e}", lanes_dir.display()))?;

        let branch = format!("lane/{letter}");
        let target_str = target.to_string_lossy().to_string();
        run_git(
            &root,
            &["worktree", "add", "-b", &branch, &target_str, "HEAD"],
        )
        .ok_or_else(|| format!("git worktree add failed for {branch}"))?;
        Ok(format!(
            "Lane {} opened at {}",
            letter.to_uppercase(),
            target_str
        ))
    })
    .await
    .map_err(|e| format!("worktree task panicked: {e}"))
    .and_then(|r: Result<String, String>| r)
    .inspect(|_| {
        // The fleet changed - drop the cache and pull every window forward.
        SNAP_STALE.store(true, std::sync::atomic::Ordering::SeqCst);
        spawn_snapshot_rebuild(app.clone());
        let _ = app.emit(
            "praxis://fd-update",
            serde_json::json!({ "kind": "worktree-added" }),
        );
    })
}

#[tauri::command]
pub fn fd_read_vault(app: tauri::AppHandle) -> Value {
    read_vault_value(&app)
}

#[tauri::command]
pub fn fd_write_vault(app: tauri::AppHandle, vault: Value) -> Result<Value, String> {
    let Some(p) = vault_path(&app) else {
        return Err("no app data dir".into());
    };
    // sanitize: keep only the known shape
    let lanes = vault
        .get("lanes")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let ro = vault
        .pointer("/config/readOnlyLanes")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    // Preserve the operator's manual lane order across writes.
    let lane_order = vault
        .pointer("/config/laneOrder")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let safe = serde_json::json!({
        "version": 1,
        "lanes": lanes,
        "config": { "readOnlyLanes": ro, "laneOrder": lane_order }
    });
    fs::write(
        &p,
        serde_json::to_string_pretty(&safe).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(safe)
}

/// Persist the operator's read-only LOCK for one lane. `lane_id` is the encoded
/// worktree path - the SAME id the deck renders and that `read_only_overrides`
/// matches against in `build_snapshot` (`overrides.contains(&encode_cwd(&wt.path))`),
/// so a lock written here surfaces as `fd_sessions`' `user_read_only`/`read_only`
/// on the next poll and gates every deck action for that lane. Reuses the vault's
/// `config.readOnlyLanes` set (the exact set `fd_read_vault`/`fd_write_vault` keep),
/// preserving queued lane prompts + manual lane order untouched. `read_only=false`
/// removes the override. Emits `praxis://fd-update` so the deck re-polls instantly.
#[tauri::command]
pub fn fd_set_lane_readonly(
    app: tauri::AppHandle,
    lane_id: String,
    read_only: bool,
) -> Result<Value, String> {
    let Some(p) = vault_path(&app) else {
        return Err("no app data dir".into());
    };
    let existing = read_vault_value(&app);
    // Rebuild the readOnlyLanes set (dedup + add/remove the target lane).
    let mut set: HashSet<String> = existing
        .pointer("/config/readOnlyLanes")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|it| it.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if read_only {
        set.insert(lane_id.clone());
    } else {
        set.remove(&lane_id);
    }
    let ro: Vec<String> = {
        let mut v: Vec<String> = set.into_iter().collect();
        v.sort(); // stable on-disk order across writes
        v
    };
    // Preserve everything else exactly (queued prompts + manual lane order).
    let lanes = existing
        .get("lanes")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let lane_order = existing
        .pointer("/config/laneOrder")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let safe = serde_json::json!({
        "version": 1,
        "lanes": lanes,
        "config": { "readOnlyLanes": ro, "laneOrder": lane_order }
    });
    fs::write(
        &p,
        serde_json::to_string_pretty(&safe).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    // Nudge the deck to re-poll so user_read_only reflects immediately (and mark
    // the snapshot cache stale so that re-poll rebuilds instead of serving the
    // pre-lock snapshot back).
    invalidate_snapshot_cache();
    let _ = app.emit(
        "praxis://fd-update",
        serde_json::json!({ "kind": "lane-readonly", "laneId": lane_id, "readOnly": read_only }),
    );
    Ok(safe)
}

// ── Session lifecycle: spawn / stop real coding sessions ──────────────────────
//
// These give the Flight Deck real muscles: launch a NEW headless coding session
// in any directory (a worktree lane, a repo root) with a prompt/model/effort, and
// terminate a running one by PID. Every session is a DETACHED child process with
// CREATE_NO_WINDOW on Windows - a Flight Deck action must NEVER flash a terminal.
//
// Drivers:
//   • "claude" | "max" | "integration" → `claude -p <prompt> …` (Claude Code headless).
//   • "codex"                          → `codex exec <prompt> …` (Codex non-interactive).
//   • "cursor"                         → `cursor-agent -p <prompt> …` IF the headless CLI
//                                        is installed; else an honest Err (no fake spawn).
//   • "cloud"                          → Err: off-machine (claude.ai/code), not spawnable here.
//
// Unlike `agent_delegate` (which BLOCKS awaiting the result for a one-shot answer),
// these are FIRE-AND-FORGET: we spawn, capture the PID + a session id, and return
// immediately so the session runs in the background and shows up on the deck via
// the running-process scan. Output/logs are redirected to a per-session log file
// under %LOCALAPPDATA%\Praxis\fd-sessions\ so nothing is lost and no console opens.

/// Result of a successful spawn - the UI stores `pid`+`driver` to later stop it,
/// and `sessionId`/`logPath` to correlate + surface output.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResult {
    /// OS process id of the detached child (use with `fd_stop_session`).
    pub pid: u32,
    /// Stable Flight-Deck-side id (uuid-ish) for this spawn.
    pub session_id: String,
    /// The driver actually used ("claude" | "codex" | "cursor").
    pub driver: String,
    /// The resolved binary path we launched.
    pub bin: String,
    /// Absolute path to the log file capturing this session's stdout+stderr.
    pub log_path: String,
    /// Absolute working directory the session was launched in.
    pub cwd: String,
}

/// The image name (Windows) a driver's process should present as - used to VERIFY
/// a PID belongs to that driver before we ever kill it.
fn driver_image(driver: &str) -> Option<&'static str> {
    match driver {
        "claude" | "max" | "integration" => Some("claude.exe"),
        "codex" => Some("codex.exe"),
        "cursor" => Some("cursor-agent.exe"),
        _ => None,
    }
}

/// Normalize a Flight Deck lane driver to the concrete spawnable tool. Lanes carry
/// UI-level drivers (max/integration map onto the same `claude` CLI); "cloud" has
/// no local target.
fn spawnable_tool(driver: &str) -> Result<&'static str, String> {
    match driver {
        "claude" | "max" | "integration" => Ok("claude"),
        "codex" => Ok("codex"),
        "cursor" => Ok("cursor"),
        "cloud" => Err(
            "Cloud lanes run off-machine on claude.ai/code — they can't be spawned as a local \
             process. Hand the work off through the cloud handoff flow instead."
                .to_string(),
        ),
        other => Err(format!(
            "unknown driver {other:?}; expected claude, codex, cursor, or cloud"
        )),
    }
}

/// Directory where per-session logs live (%LOCALAPPDATA%\Praxis\fd-sessions\).
fn fd_sessions_log_dir() -> Option<PathBuf> {
    let dir = crate::praxis_dir()?.join("fd-sessions");
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// A short, filesystem-safe unique id for a spawned session. Time-based + a random
/// nibble from the process spawn; no chrono in src-tauri so we use UNIX millis.
// ── Praxis-spawned session registry (origin truth) ──────────────────────────
//
// It was broken for every session ever shown.
//
// `fd_spawn_session` minted a synthetic id ("fd-<hex>-<hex>") and the webview
// stored THAT in a localStorage set, while session cards are keyed by the CLI
// session id (the transcript UUID). The set was checked against ids it could
// never contain, so `manual` was true for every session, `agent` was always
// "you", and FORGE / VEGA / QUILL could only ever read 0 LIVE. The PRAXIS filter
// chip rendered an empty board by construction.
//
// The join key both sides CAN see is the PID: the spawn knows the process it
// launched, and Claude's own session registry maps that pid to a session id
// (see `running_pids`). No transcript-timestamp heuristics, no id translation.
// Records for dead pids are pruned on every write, so the file stays small.

fn spawned_registry_path() -> Option<PathBuf> {
    crate::praxis_dir().map(|d| d.join("fd-spawned.json"))
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct SpawnedRecord {
    pid: u32,
    driver: String,
    cwd: String,
    spawned_at: u64,
    /// Windows FILETIME (100-ns ticks since 1601) of process creation, captured
    /// at spawn. Absent on records written before this field existed.
    #[serde(default)]
    created_at: Option<u64>,
}

/// Live observation of one pid: whether it exists right now, and its creation
/// FILETIME when we could read it. Used to reject recycled PIDs.
#[derive(Clone, Debug, PartialEq, Eq)]
struct PidIdentity {
    alive: bool,
    created_at: Option<u64>,
}

const SPAWN_RECORD_GRACE_MS: u64 = 24 * 60 * 60 * 1000;

/// A record is live only when the pid is alive AND (creation time matches, or -
/// for old records with no creation time - the record itself is younger than 24h).
fn spawned_record_is_live(
    rec: &SpawnedRecord,
    identity: Option<&PidIdentity>,
    now_ms: u64,
) -> bool {
    let Some(id) = identity else {
        return false;
    };
    if !id.alive {
        return false;
    }
    match rec.created_at {
        Some(want) => id.created_at == Some(want),
        None => now_ms.saturating_sub(rec.spawned_at) < SPAWN_RECORD_GRACE_MS,
    }
}

fn prune_spawned_records(
    records: Vec<SpawnedRecord>,
    identities: &HashMap<u32, PidIdentity>,
    now_ms: u64,
) -> Vec<SpawnedRecord> {
    records
        .into_iter()
        .filter(|r| spawned_record_is_live(r, identities.get(&r.pid), now_ms))
        .collect()
}

fn write_spawned_records(records: &[SpawnedRecord]) {
    let Some(path) = spawned_registry_path() else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(body) = serde_json::to_string_pretty(records) {
        let _ = fs::write(&path, body);
    }
}

fn read_spawned_records() -> Vec<SpawnedRecord> {
    let Some(p) = spawned_registry_path() else {
        return vec![];
    };
    fs::read_to_string(p)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<SpawnedRecord>>(&raw).ok())
        .unwrap_or_default()
}

/// FILETIME as a u64 - equality only; never converted to unix time.
#[cfg(windows)]
fn filetime_u64(ft: windows::Win32::Foundation::FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
}

/// Probe one pid: OpenProcess + GetProcessTimes. None from OpenProcess ⇒ dead.
#[cfg(windows)]
fn probe_pid(pid: u32) -> PidIdentity {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) if !h.is_invalid() => h,
            _ => {
                return PidIdentity {
                    alive: false,
                    created_at: None,
                }
            }
        };
        let mut create = windows::Win32::Foundation::FILETIME::default();
        let mut exit = windows::Win32::Foundation::FILETIME::default();
        let mut kernel = windows::Win32::Foundation::FILETIME::default();
        let mut user = windows::Win32::Foundation::FILETIME::default();
        let times = GetProcessTimes(handle, &mut create, &mut exit, &mut kernel, &mut user);
        let _ = CloseHandle(handle);
        match times {
            Ok(()) => PidIdentity {
                alive: true,
                created_at: Some(filetime_u64(create)),
            },
            Err(_) => PidIdentity {
                alive: true,
                created_at: None,
            },
        }
    }
}

#[cfg(not(windows))]
fn probe_pid(_pid: u32) -> PidIdentity {
    PidIdentity {
        alive: false,
        created_at: None,
    }
}

fn probe_identities(pids: impl Iterator<Item = u32>) -> HashMap<u32, PidIdentity> {
    let mut out = HashMap::new();
    for pid in pids {
        out.entry(pid).or_insert_with(|| probe_pid(pid));
    }
    out
}

fn live_spawned_records() -> Vec<SpawnedRecord> {
    let records = read_spawned_records();
    let original_len = records.len();
    if original_len == 0 {
        return records;
    }
    let now = now_ms();
    let identities = probe_identities(records.iter().map(|r| r.pid));
    let pruned = prune_spawned_records(records, &identities, now);
    if pruned.len() != original_len {
        write_spawned_records(&pruned);
    }
    pruned
}

/// Record a session Praxis just launched, and drop records whose process is gone
/// or whose pid was recycled onto a different process.
fn note_spawned(pid: u32, driver: &str, cwd: &str) {
    let now = now_ms();
    let identity = probe_pid(pid);
    let created_at = if identity.alive {
        identity.created_at
    } else {
        None
    };

    let mut records: Vec<SpawnedRecord> = read_spawned_records()
        .into_iter()
        .filter(|r| r.pid != pid)
        .collect();
    let identities = probe_identities(records.iter().map(|r| r.pid));
    records = prune_spawned_records(records, &identities, now);
    records.push(SpawnedRecord {
        pid,
        driver: driver.to_string(),
        cwd: cwd.to_string(),
        spawned_at: now,
        created_at,
    });
    write_spawned_records(&records);
}

/// PIDs Praxis launched that are still the SAME live process - the set a
/// session's own pid is tested against to decide `origin`. Prunes on read.
fn spawned_pids() -> HashSet<u32> {
    live_spawned_records().into_iter().map(|r| r.pid).collect()
}

#[cfg(test)]
mod spawned_registry_tests {
    use super::*;

    fn rec(pid: u32, spawned_at: u64, created_at: Option<u64>) -> SpawnedRecord {
        SpawnedRecord {
            pid,
            driver: "claude".into(),
            cwd: "C:/repo".into(),
            spawned_at,
            created_at,
        }
    }

    #[test]
    fn dead_pid_is_never_live() {
        let r = rec(10, 1_000, Some(99));
        assert!(!spawned_record_is_live(
            &r,
            Some(&PidIdentity {
                alive: false,
                created_at: Some(99)
            }),
            2_000
        ));
        assert!(!spawned_record_is_live(&r, None, 2_000));
    }

    #[test]
    fn matching_creation_time_is_live() {
        let r = rec(10, 1_000, Some(99));
        assert!(spawned_record_is_live(
            &r,
            Some(&PidIdentity {
                alive: true,
                created_at: Some(99)
            }),
            2_000
        ));
    }

    #[test]
    fn recycled_pid_with_different_creation_time_is_rejected() {
        let r = rec(10, 1_000, Some(99));
        assert!(
            !spawned_record_is_live(
                &r,
                Some(&PidIdentity {
                    alive: true,
                    created_at: Some(100)
                }),
                2_000
            ),
            "a later process reusing the pid must not be labelled PRAXIS origin"
        );
    }

    #[test]
    fn old_record_without_creation_time_accepted_only_if_alive_and_under_24h() {
        let now = SPAWN_RECORD_GRACE_MS + 5_000;
        let young = rec(10, now - 1_000, None);
        let stale = rec(11, 1, None);
        let alive = PidIdentity {
            alive: true,
            created_at: Some(1),
        };
        assert!(spawned_record_is_live(&young, Some(&alive), now));
        assert!(
            !spawned_record_is_live(&stale, Some(&alive), now),
            "a record older than 24h with no creation time must not claim a live pid"
        );
    }

    #[test]
    fn prune_drops_dead_and_recycled_and_keeps_matches() {
        let now = SPAWN_RECORD_GRACE_MS + 10_000;
        let records = vec![
            rec(1, now - 1_000, Some(11)), // match
            rec(2, now - 1_000, Some(22)), // recycled
            rec(3, now - 1_000, Some(33)), // dead
            rec(4, now - 1_000, None),     // old-format, young, alive
            rec(5, 1, None),               // old-format, older than 24h
        ];
        let mut ids = HashMap::new();
        ids.insert(
            1,
            PidIdentity {
                alive: true,
                created_at: Some(11),
            },
        );
        ids.insert(
            2,
            PidIdentity {
                alive: true,
                created_at: Some(99),
            },
        );
        ids.insert(
            3,
            PidIdentity {
                alive: false,
                created_at: None,
            },
        );
        ids.insert(
            4,
            PidIdentity {
                alive: true,
                created_at: Some(44),
            },
        );
        ids.insert(
            5,
            PidIdentity {
                alive: true,
                created_at: Some(55),
            },
        );
        let kept: Vec<u32> = prune_spawned_records(records, &ids, now)
            .into_iter()
            .map(|r| r.pid)
            .collect();
        assert_eq!(kept, vec![1, 4]);
    }

    #[test]
    fn old_json_without_created_at_deserializes() {
        let raw = r#"[{"pid":7,"driver":"codex","cwd":"C:/x","spawned_at":1}]"#;
        let recs: Vec<SpawnedRecord> = serde_json::from_str(raw).expect("legacy json");
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].pid, 7);
        assert_eq!(recs[0].created_at, None);
    }
}

fn new_session_id() -> String {
    let ms = now_ms();
    // Mix in a bit of address-space entropy so two spawns in the same ms differ.
    let salt = &new_session_id as *const _ as usize as u64;
    format!("fd-{ms:x}-{:x}", salt & 0xffff)
}

/// Spawn a NEW headless coding session.
///
/// `dir` - absolute working directory / worktree the session runs in.
/// `prompt` - the task prompt handed to the CLI.
/// `driver` - lane driver ("claude"/"max"/"integration"/"codex"/"cursor"/"cloud").
/// `model` - optional model alias/name passed through to the CLI (`--model`/`-m`).
/// `effort` - optional effort level; only `claude` accepts `--effort`
///             (low|medium|high|xhigh|max). Ignored for other drivers.
///
/// Returns a `SpawnResult` with the PID + session id. The child is fully detached:
/// stdin null, stdout+stderr → the session log file, CREATE_NO_WINDOW on Windows.
#[tauri::command]
pub async fn fd_spawn_session(
    app: tauri::AppHandle,
    dir: String,
    prompt: String,
    driver: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<SpawnResult, String> {
    let tool = spawnable_tool(&driver)?;

    if prompt.trim().is_empty() {
        return Err("prompt is empty — nothing to run".into());
    }
    if !Path::new(&dir).is_dir() {
        return Err(format!("working directory does not exist: {dir}"));
    }

    // Cursor headless spawn is only possible if the agent CLI is actually installed.
    let bin = crate::hermes_bridge::resolve_bin(match tool {
        "claude" => "claude",
        "codex" => "codex",
        "cursor" => "cursor-agent",
        _ => unreachable!(),
    });
    if tool == "cursor" && bin == "cursor-agent" {
        return Err(
            "Cursor sessions can't be spawned headlessly on this machine — the `cursor-agent` CLI \
             isn't installed. Open Composer in the Cursor IDE, or install the headless CLI with \
             `irm 'https://cursor.com/install?win32=true' | iex`."
                .to_string(),
        );
    }

    let session_id = new_session_id();
    let log_dir = fd_sessions_log_dir().ok_or_else(|| {
        "could not create Flight Deck session log dir (%LOCALAPPDATA% unset?)".to_string()
    })?;
    let log_path = log_dir.join(format!("{session_id}.log"));
    let log_file = fs::File::create(&log_path)
        .map_err(|e| format!("could not open session log {}: {e}", log_path.display()))?;
    let log_err = log_file
        .try_clone()
        .map_err(|e| format!("could not clone session log handle: {e}"))?;

    // `.cmd` shims (codex on Windows) must run through `cmd /C`; native `.exe`
    // launch directly - same rule as hermes_bridge::make_cmd.
    use std::process::{Command, Stdio};
    // ONE shared launcher (hermes_bridge::spawn_target). This used to have its OWN
    // `cmd /C` branch, so when make_async_cmd was fixed, SPAWNED sessions stayed broken:
    // a Codex lane logged "Not inside a trusted directory and --skip-git-repo-check was
    // not specified" while this very function passes that flag. cmd.exe had cut the line
    // at the prompt's first newline and dropped every flag after it.
    let (prog, lead) = crate::hermes_bridge::spawn_target(&bin);
    let mut cmd = Command::new(prog);
    for a in lead {
        cmd.arg(a);
    }

    match tool {
        "claude" => {
            // Headless Claude Code: -p prints and exits; strict-mcp-config avoids the
            // multi-minute MCP fleet cold-start; skip-permissions so it never blocks on
            // an approval prompt with no TTY. --add-dir lets it also touch `dir`.
            cmd.arg("-p")
                .arg(&prompt)
                .arg("--output-format")
                .arg("json")
                .arg("--strict-mcp-config")
                // See HEADLESS_CLAUDE_SETTINGS: a hanging SessionStart hook
                // otherwise stalls every spawned lane before it starts.
                .arg("--settings")
                .arg(crate::hermes_bridge::HEADLESS_CLAUDE_SETTINGS)
                .arg("--dangerously-skip-permissions")
                .arg("--add-dir")
                .arg(&dir);
            if let Some(m) = model.as_deref().filter(|m| !m.trim().is_empty()) {
                cmd.arg("--model").arg(m.trim());
            }
            if let Some(e) = effort.as_deref().filter(|e| !e.trim().is_empty()) {
                // Claude accepts: low|medium|high|xhigh|max. Pass through; an
                // unrecognized value is rejected loudly by the CLI (surfaces in the log).
                cmd.arg("--effort").arg(e.trim());
            }
        }
        "codex" => {
            // Non-interactive Codex. -C sets the working root; bypass approvals+sandbox
            // so it can act without a TTY; skip-git-repo-check so non-repo dirs run.
            // (Codex has no --effort flag; effort is silently ignored for this driver.)
            cmd.arg("exec")
                .arg(&prompt)
                .arg("--json")
                .arg("--dangerously-bypass-approvals-and-sandbox")
                .arg("--skip-git-repo-check")
                .arg("-C")
                .arg(&dir);
            if let Some(m) = model.as_deref().filter(|m| !m.trim().is_empty()) {
                cmd.arg("--model").arg(m.trim());
            }
        }
        "cursor" => {
            // Headless cursor-agent: -p non-interactive, --force writes without a
            // confirmation prompt. (No --effort; --model passed through when given.)
            // --trust as well as --force: they are DIFFERENT gates. --force allows
            // commands, but an unfamiliar working directory still prompts
            // "Do you trust the contents of this directory?" and a headless spawn has
            // no TTY to answer it - the session just sat there and died. Seen
            // 2026-09-16 spawning into praxis-lanes\spawn-test. Praxis only ever
            // passes a directory the owner explicitly aimed the work at, and the claude and
            // codex arms already carry their equivalents.
            cmd.arg("-p")
                .arg(&prompt)
                .arg("--output-format")
                .arg("json")
                .arg("--force")
                .arg("--trust");
            if let Some(m) = model.as_deref().filter(|m| !m.trim().is_empty()) {
                cmd.arg("--model").arg(m.trim());
            }
        }
        _ => unreachable!(),
    }

    cmd.current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_err));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (0x08000000): detached, no console flash - hard requirement.
        cmd.creation_flags(0x0800_0000);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn {tool} session: {e}"))?;
    let pid = child.id();
    // Detach: we intentionally drop the Child handle without waiting. The process
    // keeps running; liveness is tracked by the running-process scan + tasklist.
    drop(child);

    crate::dlog!(
        "[flight-deck] spawned {tool} session pid={pid} id={session_id} dir={dir} model={:?}",
        model
    );

    // Push an instant refresh so the UI doesn't wait for its 6s poll to see the new lane.
    invalidate_snapshot_cache();
    let _ = app.emit(
        "praxis://fd-update",
        serde_json::json!({
            "kind": "spawn",
            "sessionId": session_id,
            "pid": pid,
            "driver": tool,
            "cwd": dir,
        }),
    );

    // Record the PID so the snapshot can tell this session apart from one the owner
    // started by hand. Written before returning so the very next poll sees it.
    note_spawned(pid, tool, &dir);

    Ok(SpawnResult {
        pid,
        session_id,
        driver: tool.to_string(),
        bin,
        log_path: log_path.to_string_lossy().into_owned(),
        cwd: dir,
    })
}

/// True when PID `pid` is currently running AND its image name matches `expected`
/// (Windows). This is the SAFETY GATE for `fd_stop_session`: we never kill a PID
/// unless we've confirmed it's actually the driver's process image - a stale PID
/// could have been recycled by the OS onto an unrelated process.
#[cfg(windows)]
fn pid_matches_image(pid: u32, expected: &str) -> bool {
    use std::os::windows::process::CommandExt;
    let filter = format!("PID eq {pid}");
    let mut cmd = std::process::Command::new("tasklist");
    cmd.args(["/NH", "/FO", "CSV", "/FI", filter.as_str()])
        .creation_flags(0x0800_0000);
    let Some(out) = output_with_timeout(cmd, PROCESS_PROBE_TIMEOUT) else {
        return false;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        // CSV row: "claude.exe","12345","Console","1","123,456 K"
        let cols: Vec<&str> = line.split("\",\"").collect();
        if cols.len() >= 2 {
            let image = cols[0].trim_matches('"').trim();
            if image.eq_ignore_ascii_case(expected) {
                return true;
            }
        }
    }
    false
}

#[cfg(not(windows))]
fn pid_matches_image(_pid: u32, _expected: &str) -> bool {
    // Praxis ships on Windows only; on other platforms we can't verify the image,
    // so fail the safety check rather than kill an unverified PID.
    false
}

/// Stop a running session by PID, verifying the process image matches `driver`
/// BEFORE killing so we never terminate an arbitrary/recycled PID. Kills the whole
/// child tree (`taskkill /T`) so any subprocesses the session spawned die too.
#[tauri::command]
pub async fn fd_stop_session(
    app: tauri::AppHandle,
    pid: u32,
    driver: String,
) -> Result<String, String> {
    let expected = driver_image(&driver).ok_or_else(|| {
        format!("driver {driver:?} has no killable local process (cloud/off-machine?)")
    })?;

    if !pid_matches_image(pid, expected) {
        return Err(format!(
            "refusing to kill pid {pid}: it is not a running {expected} process (already exited, or \
             the PID was recycled onto another program)."
        ));
    }

    use std::process::Command;
    let mut cmd = Command::new("taskkill");
    cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd
        .output()
        .map_err(|e| format!("taskkill failed to run: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("taskkill exited {:?}: {stderr}", out.status.code()));
    }

    crate::dlog!("[flight-deck] stopped {driver} session pid={pid}");

    // Instant refresh so the lane clears without waiting for the 6s poll.
    invalidate_snapshot_cache();
    let _ = app.emit(
        "praxis://fd-update",
        serde_json::json!({
            "kind": "stop",
            "pid": pid,
            "driver": driver,
        }),
    );

    Ok(format!("stopped {driver} session (pid {pid})"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── ACTIVE WINDOW (the visibility rule) ──────────────────────────────────
    // Locks the behaviour the owner asked for on 2026-09-03: the deck shows current
    // active sessions, the way Claude Code's own left-hand panel does - not every
    // session he has ever opened.

    /// A running session is visible at ANY age, in every window setting. This is
    /// the one rule that must never regress: hiding live work would be worse than
    /// the graveyard it replaced.
    #[test]
    fn running_sessions_are_never_hidden() {
        for w in [
            ACTIVE_WINDOW_ALL,
            60 * 60 * 1000,
            24 * 60 * 60 * 1000,
            7 * 24 * 60 * 60 * 1000,
        ] {
            ACTIVE_WINDOW.store(w, std::sync::atomic::Ordering::Relaxed);
            assert!(
                within_active_window(365 * 24 * 60 * 60 * 1000, true),
                "a live process must stay visible in window {w}"
            );
        }
        ACTIVE_WINDOW.store(
            DEFAULT_ACTIVE_WINDOW_MS,
            std::sync::atomic::Ordering::Relaxed,
        );
    }

    #[test]
    fn idle_sessions_obey_the_window() {
        // The DEFAULT window is now ALL (strict account scoping does the filtering
        // - see current_account_keys), so pin an explicit 24h to test the gate.
        const DAY: u64 = 24 * 60 * 60 * 1000;
        ACTIVE_WINDOW.store(DAY, std::sync::atomic::Ordering::Relaxed);
        assert!(
            within_active_window(60 * 60 * 1000, false),
            "1h ago is inside 24h"
        );
        assert!(
            within_active_window(DAY, false),
            "exactly at the edge is still active"
        );
        assert!(
            !within_active_window(DAY + 1, false),
            "a minute past the window drops off the deck"
        );
        assert!(
            !within_active_window(40 * DAY, false),
            "a 40-day-old session must not show inside a 24h window"
        );
        ACTIVE_WINDOW.store(
            DEFAULT_ACTIVE_WINDOW_MS,
            std::sync::atomic::Ordering::Relaxed,
        );
    }

    /// "ALL" is a real escape hatch, not a bigger number that still truncates.
    #[test]
    fn all_window_disables_the_time_filter() {
        ACTIVE_WINDOW.store(ACTIVE_WINDOW_ALL, std::sync::atomic::Ordering::Relaxed);
        assert!(within_active_window(10 * 365 * 24 * 60 * 60 * 1000, false));
        ACTIVE_WINDOW.store(
            DEFAULT_ACTIVE_WINDOW_MS,
            std::sync::atomic::Ordering::Relaxed,
        );
    }

    /// The store is `<accountUuid>/<organizationUuid>/local_*.json`; an unexpected
    /// layout must yield "" (treated as always-current) so a Claude Code change
    /// can never blank the deck.
    #[test]
    fn account_key_reads_the_store_layout() {
        let store = PathBuf::from("C:/store");
        assert_eq!(
            account_key_of(
                &store,
                &store.join("acct-1").join("org-2").join("local_x.json")
            ),
            "acct-1/org-2"
        );
        assert_eq!(
            account_key_of(&store, &store.join("local_x.json")),
            "",
            "a flat layout must not be filtered out"
        );
        assert_eq!(
            account_key_of(&store, &PathBuf::from("C:/elsewhere/local_x.json")),
            "",
            "a path outside the store must not be filtered out"
        );
    }

    /// The owner switches between three Claude accounts on this machine and Claude Code's own sidebar
    /// shows exactly one of them.
    #[test]
    fn only_his_accounts_are_current() {
        let keys = current_account_keys(&[], 0);
        assert!(keys.contains(""), "unknown layout is always admitted");
        assert!(!keys.contains("some-other-account/some-other-org"));

        let allowed = remembered_allowed_keys();
        let signed_in = signed_in_account();
        let desktop = desktop_account_uuid();
        for key in keys.iter().filter(|k| !k.is_empty()) {
            let uuid = key.split('/').next().unwrap_or("");
            let via_desktop = desktop.as_deref() == Some(uuid);
            let via_ledger = allowed.contains(key) || allowed.contains(uuid);
            let via_sign_in = signed_in
                .as_ref()
                .is_some_and(|(k, _)| k == key || k.split('/').next() == Some(uuid));
            assert!(
                via_ledger || via_sign_in || via_desktop,
                "{key} is on the deck without belonging to an allowed or signed-in account"
            );
        }

        if let Some((key, email)) = signed_in {
            if email_is_allowed(&email) || email.is_empty() {
                assert!(
                    keys.contains(&key),
                    "the signed-in account {email} must be on the deck"
                );
            } else {
                assert!(
                    keys.contains(&key),
                    "signed-in account must be admitted even when unmapped"
                );
            }
        }
    }

    /// The turn-state parser is what separates ACTIVE (a window is open) from
    /// RUNNING (a prompt is going). Getting this wrong put agents in orbit around
    /// nothing, so it is pinned to the real transcript shapes.
    #[test]
    fn turn_state_reads_the_last_turn_record() {
        let dir = std::env::temp_dir().join("praxis-turn-test");
        let _ = fs::create_dir_all(&dir);
        let write = |name: &str, body: &str| {
            let p = dir.join(name);
            fs::write(&p, body).unwrap();
            p
        };

        // Assistant finished its turn → the session is waiting for the owner. NOT running.
        let idle = write(
            "idle.jsonl",
            r#"{"type":"user","timestamp":"2026-09-05T20:00:00.000Z","message":{"content":"hi"}}
{"type":"assistant","timestamp":"2026-09-05T20:00:05.000Z","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}
{"type":"attachment","timestamp":"2026-09-05T20:43:00.000Z"}
{"type":"queue-operation","timestamp":"2026-09-05T20:43:10.000Z"}"#,
        );
        let t = read_transcript_tail(&idle);
        assert!(!t.turn_in_flight, "end_turn means waiting, not working");
        assert!(t.turn_ts > 0, "timestamp of the last TURN must be parsed");

        // The trailing attachment/queue-operation records are ~43 minutes newer
        // than the last turn. Age must follow the TURN, not the file.
        let mtime_ts = parse_iso_ms("2026-09-05T20:43:10.000Z").unwrap();
        assert!(
            mtime_ts - t.turn_ts > 40 * 60 * 1000,
            "this fixture only proves anything if the noise records are much newer"
        );

        // A tool_result (written as a `user` record) means the turn continues.
        let busy = write(
            "busy.jsonl",
            r#"{"type":"assistant","timestamp":"2026-09-05T20:00:00.000Z","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","name":"Bash","input":{}}]}}
{"type":"user","timestamp":"2026-09-05T20:00:01.000Z","message":{"content":[{"type":"tool_result"}]}}"#,
        );
        assert!(
            read_transcript_tail(&busy).turn_in_flight,
            "a tool_result means the assistant is still working"
        );

        // Assistant stopped to request a tool → still inside the turn.
        let tool = write(
            "tool.jsonl",
            r#"{"type":"user","timestamp":"2026-09-05T20:00:00.000Z","message":{"content":"go"}}
{"type":"assistant","timestamp":"2026-09-05T20:00:02.000Z","message":{"stop_reason":"tool_use","content":[{"type":"tool_use","name":"Read","input":{}}]}}"#,
        );
        assert!(read_transcript_tail(&tool).turn_in_flight);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn iso_timestamps_parse_to_epoch_ms() {
        // 2026-09-05T20:43:09.235Z - checked against a known epoch value.
        assert_eq!(
            parse_iso_ms("2026-09-05T20:43:09.235Z"),
            Some(1_788_640_989_235)
        );
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso_ms("not-a-timestamp"), None);
        assert_eq!(
            parse_iso_ms("2026-13-05T20:43:09.235Z"),
            None,
            "month 13 is junk"
        );
    }

    // Real-data smoke test: prints what Flight Deck will actually show, against
    // the live Claude state on this machine. Run with:
    //   cargo test -p praxis flightdeck::tests::dump -- --nocapture
    #[test]
    fn dump() {
        let snap = build_snapshot_with(&HashSet::new(), true);
        eprintln!("projectsDir: {}", snap.projects_dir);
        eprintln!("repos (active): {}", snap.repos.len());
        for repo in &snap.repos {
            eprintln!(
                "  ▸ {:<18} lanes={} running_lanes={} parallel={} collision={}",
                repo.label, repo.lane_count, repo.running_lane_count, repo.parallel, repo.collision
            );
            for l in &repo.lanes {
                eprintln!(
                    "       · {:<14} driver={:<11} branch={:?} port={:?} live={} recent={} collision={}",
                    l.label, l.driver, l.branch, l.port, l.live_count, l.recent_count, l.collision
                );
            }
        }
        // Encoding must match the on-disk projects folder naming.
        assert_eq!(
            encode_cwd("C:\\Users\\dev\\Desktop\\catalyzed-alpha"),
            "C--Users-dev-Desktop-catalyzed-alpha"
        );
    }

    #[test]
    fn missing_cursor_last_update_uses_real_fallback_and_chat_stays_dormant() {
        let now = 10 * RECENT_MS;
        let checkpoint = now - RECENT_MS - 1;
        let composer = serde_json::json!({
            "composerId": "historical-chat",
            "unifiedMode": "chat",
            "forceMode": "edit",
            "worktreeStartedReadOnly": false,
            "conversationCheckpointLastUpdatedAt": checkpoint,
            "createdAt": checkpoint - 1_000
        });

        let mtime = cursor_composer_mtime(&composer);
        assert_eq!(
            mtime, checkpoint,
            "missing lastUpdatedAt must not become now"
        );
        assert_eq!(liveness(now.saturating_sub(mtime)), "dormant");
        assert!(!cursor_composer_is_mutable_agent(&composer));
        assert!(!cursor_composer_is_running(
            now, mtime, true, true, false, false
        ));

        let no_timestamp = serde_json::json!({ "unifiedMode": "chat" });
        assert_eq!(cursor_composer_mtime(&no_timestamp), 0);
        assert!(!cursor_composer_is_fresh(now, 0));
    }

    #[test]
    fn stale_cursor_agent_ignores_irrelevant_rows_after_turn_end() {
        let tail = concat!(
            "{\"role\":\"user\",\"message\":{}}\n",
            "{\"role\":\"assistant\",\"message\":{}}\n",
            "{\"type\":\"turn_ended\",\"status\":\"success\"}\n",
            "{\"kind\":\"checkpoint\",\"type\":null}\n",
            "not-json\n"
        );
        assert_eq!(
            cursor_turn_state_from_tail(tail, false),
            CursorTurnState::Ended
        );

        let now = 20 * RECENT_MS;
        let stale_mtime = now - RECENT_MS - 1;
        assert!(!cursor_composer_is_running(
            now,
            stale_mtime,
            true,
            true,
            true,
            true
        ));
    }

    #[test]
    fn fresh_mutable_cursor_agent_with_open_turn_is_live() {
        let tail = concat!(
            "{\"type\":\"turn_ended\",\"status\":\"success\"}\n",
            "{\"role\":\"user\",\"message\":{}}\n",
            "{\"role\":\"assistant\",\"message\":{}}\n",
            "{\"kind\":\"tool-progress\"}\n"
        );
        assert_eq!(
            cursor_turn_state_from_tail(tail, false),
            CursorTurnState::InFlight
        );

        let now = 30 * RECENT_MS;
        let composer = serde_json::json!({
            "unifiedMode": "agent",
            "forceMode": "edit",
            "worktreeStartedReadOnly": false,
            "lastUpdatedAt": now - 1_000
        });
        let mtime = cursor_composer_mtime(&composer);
        assert!(cursor_composer_is_mutable_agent(&composer));
        assert!(cursor_composer_is_running(
            now, mtime, true, true, true, true
        ));
    }

    #[test]
    fn cursor_collision_counts_only_live_mutable_agents() {
        let now = 40 * RECENT_MS;
        let project = RepoInfo {
            root_alias: None,
            key: "repo".into(),
            root: "C:/repo".into(),
            label: "Repo".into(),
            specs: vec![],
            worktrees: vec![WorktreeInfo {
                path: "C:/repo".into(),
                branch: None,
                head: None,
            }],
        };
        let session = |id: &str, mutable| {
            cursor_session_to_card(
                &CursorSession {
                    bubble_count: 1,
                    id: id.into(),
                    cwd: project.root.clone(),
                    title: Some(id.into()),
                    model: None,
                    mtime: now - 1000,
                    running: true,
                    mutable,
                },
                now,
            )
        };
        for (mutable, expected) in [(false, 1), (true, 2)] {
            let r = route_sessions(
                vec![session("one", true), session("two", mutable)],
                std::slice::from_ref(&project),
                &OwnerPaths::new("C:/Users/test", "C:/Users/test/AppData/Local"),
                86_400_000,
            );
            let builders = r.accum["repo"].bundles["c:/repo"].live_builder_count;
            assert_eq!(builders, expected);
            assert_eq!(has_builder_collision(builders, false, false), mutable);
            assert!(!has_builder_collision(builders, true, false));
            assert!(!has_builder_collision(builders, false, true));
        }
    }

    #[test]
    fn manifest_classifies_drivers() {
        assert_eq!(classify_driver(&["Cursor Composer"]), "cursor");
        assert_eq!(classify_driver(&["Codex offload (zero Max)"]), "codex");
        assert_eq!(classify_driver(&["claude.ai/code sandboxes"]), "cloud");
        assert_eq!(
            classify_driver(&["Owns main/deploy + does all merges"]),
            "integration"
        );
        assert_eq!(classify_driver(&["Claude (Max)"]), "max");
        assert_eq!(classify_driver(&["something else"]), "claude");
    }

    #[test]
    fn common_dir_finds_lanes_folder() {
        let parents = vec![
            "C:/Users/dev/Desktop/catalyzed-lanes".to_string(),
            "C:/Users/dev/Desktop/catalyzed-lanes".to_string(),
        ];
        assert_eq!(
            common_dir(&parents).as_deref(),
            Some("C:/Users/dev/Desktop/catalyzed-lanes")
        );
    }
}

#[cfg(test)]
mod cursor_schema_tests {
    use super::*;

    /// The schema Cursor actually ships (measured 2026-09-14: 113 rows).
    fn db_with_table() -> rusqlite::Connection {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT,
                createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER,
                recency INTEGER, checkpointAt INTEGER, value TEXT, subagentTypeName TEXT);",
        )
        .unwrap();
        c
    }

    #[test]
    fn the_current_schema_is_read() {
        let c = db_with_table();
        c.execute(
            "INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, value)
             VALUES ('c1', 'ws-hash', 100, 5000, 0, '{\"name\":\"Brain dump orchestration task\"}')",
            [],
        )
        .unwrap();
        let rows = cursor_rows_from_table(&c).expect("table present");
        assert_eq!(rows.len(), 1);
        let (id, ws, ts, value) = &rows[0];
        assert_eq!(id, "c1");
        assert_eq!(ws, "ws-hash");
        assert_eq!(*ts, 5000, "lastUpdatedAt wins over createdAt");
        assert_eq!(
            value.get("name").and_then(|v| v.as_str()),
            Some("Brain dump orchestration task")
        );
    }

    #[test]
    fn archived_composers_stay_off_the_deck() {
        let c = db_with_table();
        c.execute("INSERT INTO composerHeaders (composerId, isArchived, createdAt) VALUES ('gone', 1, 10)", []).unwrap();
        c.execute("INSERT INTO composerHeaders (composerId, isArchived, createdAt) VALUES ('here', 0, 10)", []).unwrap();
        let rows = cursor_rows_from_table(&c).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "here");
    }

    #[test]
    fn a_composer_with_no_timestamp_is_not_dated_now() {
        // Every time field NULL -> 0, and the caller drops it rather than stamping
        // the wall clock, which would float an ancient chat to the top of the deck.
        let c = db_with_table();
        c.execute(
            "INSERT INTO composerHeaders (composerId, isArchived) VALUES ('undated', 0)",
            [],
        )
        .unwrap();
        assert_eq!(cursor_rows_from_table(&c).unwrap()[0].2, 0);
    }

    #[test]
    fn an_older_cursor_falls_back_to_the_blob() {
        // No composerHeaders table => None => the caller reads ItemTable instead.
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);")
            .unwrap();
        assert!(cursor_rows_from_table(&c).is_none());
    }

    #[test]
    fn workspace_uris_decode_to_windows_paths() {
        assert_eq!(
            cursor_uri_to_path("file:///c%3A/Users/dev/Desktop/praxis").as_deref(),
            Some(r"c:\Users\dev\Desktop\praxis"),
        );
        // A space is %20; both separators normalise.
        assert_eq!(
            cursor_uri_to_path("file:///d%3A/My%20Work/repo").as_deref(),
            Some(r"d:\My Work\repo"),
        );
        assert_eq!(cursor_uri_to_path("not-a-uri"), None);
        assert_eq!(cursor_uri_to_path("file:///"), None);
        assert_eq!(
            cursor_path_from_workspace_identifier(&serde_json::json!({
                "id": "hash",
                "uri": { "external": "file:///c%3A/Users/dev/Desktop/praxis" }
            }))
            .as_deref(),
            Some(r"c:\Users\dev\Desktop\praxis"),
        );
    }

    fn fixture_dir(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("praxis-cursor-fix-{name}"));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn classify_row(
        workspace_id: &str,
        ts: u64,
        value: &Value,
        folders: &HashMap<String, String>,
        now: u64,
    ) -> (&'static str, Option<String>, u64) {
        let mtime = cursor_normalize_timestamp(ts).max(cursor_composer_mtime(value));
        let cwd = cursor_resolve_cwd(workspace_id, value, folders);
        let why = cursor_composer_why(false, &cwd, mtime, now, false);
        (why, cursor_cwd_path(&cwd), mtime)
    }

    #[test]
    fn blank_drafts_and_untouched_ephemeral_composers_are_not_sessions() {
        // The three shapes measured on the owner's machine, 2026-09-15.
        assert!(cursor_composer_is_placeholder(&serde_json::json!({
            "composerId": "empty-state-draft", "isDraft": true, "unifiedMode": "agent"
        })));
        assert!(cursor_composer_is_placeholder(&serde_json::json!({
            "composerId": "00000003", "isEphemeral": true, "isDraft": false, "createdAt": 1_789_480_230_380u64
        })));
        // An ephemeral chat that was actually used is a session.
        assert!(!cursor_composer_is_placeholder(&serde_json::json!({
            "isEphemeral": true, "lastUpdatedAt": 1_789_480_300_000u64, "name": "Real question"
        })));
        // Ordinary named chats are untouched.
        assert!(!cursor_composer_is_placeholder(&serde_json::json!({
            "name": "Codex usage accuracy issue", "isDraft": false, "lastUpdatedAt": 1_789_480_250_000u64
        })));
    }

    #[test]
    fn fixture_rows_cover_each_cursor_inclusion_class() {
        let now = 1_789_500_000_000u64;
        let prev = active_window_ms();
        ACTIVE_WINDOW.store(
            CURSOR_CENSUS_WINDOW_MS,
            std::sync::atomic::Ordering::Relaxed,
        );

        let untracked = fixture_dir("untracked");
        let ws_root = fixture_dir("multiroot");
        let ws_app = ws_root.join("app");
        fs::create_dir_all(&ws_app).unwrap();
        let ws_file = ws_root.join("fleet.code-workspace");
        fs::write(&ws_file, r#"{"folders":[{"path":"app"},{"path":"other"}]}"#).unwrap();

        let c = db_with_table();
        let insert = |c: &rusqlite::Connection, id: &str, ws: &str, ts: i64, value: &Value| {
            c.execute(
                "INSERT INTO composerHeaders (composerId, workspaceId, lastUpdatedAt, isArchived, value)
                 VALUES (?1, ?2, ?3, 0, ?4)",
                rusqlite::params![id, ws, ts, value.to_string()],
            )
            .unwrap();
        };

        insert(
            &c,
            "untracked",
            "ws-untracked",
            now as i64 - 1_000,
            &serde_json::json!({
                "name": "Notes in a loose folder",
                "unifiedMode": "agent",
                "workspaceIdentifier": {
                    "id": "ws-untracked",
                    "uri": { "fsPath": untracked.to_string_lossy() }
                }
            }),
        );
        insert(
            &c,
            "agents",
            "empty-window",
            now as i64 - 2_000,
            &serde_json::json!({
                "name": "",
                "subtitle": "Fix the session list please",
                "unifiedMode": "agent",
                "workspaceIdentifier": { "id": "empty-window" }
            }),
        );
        insert(
            &c,
            "seconds",
            "ws-seconds",
            ((now - 3_000) / 1000) as i64,
            &serde_json::json!({
                "name": "Seconds stamped chat",
                "unifiedMode": "chat",
                "workspaceIdentifier": {
                    "id": "ws-seconds",
                    "uri": { "fsPath": untracked.to_string_lossy() }
                }
            }),
        );
        insert(
            &c,
            "multiroot",
            "ws-multi",
            now as i64 - 4_000,
            &serde_json::json!({
                "name": "Multi root agents",
                "unifiedMode": "agent",
                "workspaceIdentifier": {
                    "id": "ws-multi",
                    "uri": { "fsPath": ws_file.to_string_lossy() }
                }
            }),
        );
        insert(
            &c,
            "nofs",
            "ws-nofs",
            now as i64 - 5_000,
            &serde_json::json!({
                "name": "URI without fsPath",
                "unifiedMode": "agent",
                "workspaceIdentifier": {
                    "id": "ws-nofs"
                }
            }),
        );
        insert(
            &c,
            "missing",
            "ws-missing",
            now as i64 - 6_000,
            &serde_json::json!({
                "name": "Deleted worktree",
                "unifiedMode": "agent",
                "workspaceIdentifier": {
                    "id": "ws-missing",
                    "uri": { "fsPath": r"C:\praxis-missing-cursor-folder-xyz" }
                }
            }),
        );
        c.execute(
            "INSERT INTO composerHeaders (composerId, workspaceId, lastUpdatedAt, isArchived, value)
             VALUES ('old', 'ws-untracked', ?1, 0, '{}')",
            rusqlite::params![now as i64 - (CURSOR_CENSUS_WINDOW_MS as i64) - 5_000],
        )
        .unwrap();
        c.execute(
            "INSERT INTO composerHeaders (composerId, isArchived, lastUpdatedAt, value)
             VALUES ('archived', 1, ?1, '{\"name\":\"gone\"}')",
            rusqlite::params![now as i64 - 1_000],
        )
        .unwrap();

        let rows = cursor_rows_from_table(&c).unwrap();
        let mut folders = HashMap::new();
        folders.insert(
            "ws-nofs".to_string(),
            untracked.to_string_lossy().into_owned(),
        );
        let mut by_id: HashMap<String, (&'static str, Option<String>, u64)> = HashMap::new();
        for (id, ws, ts, value) in &rows {
            by_id.insert(id.clone(), classify_row(ws, *ts, value, &folders, now));
        }

        let (why, cwd, _) = &by_id["untracked"];
        assert_eq!(*why, "on deck", "untracked folder must still show");
        assert_eq!(
            cwd.as_deref().map(norm_path),
            Some(norm_path(&untracked.to_string_lossy()))
        );

        let (why, cwd, _) = &by_id["agents"];
        assert_eq!(*why, "on deck", "Agents window must still show");
        assert_eq!(cwd.as_deref(), Some(CURSOR_AGENTS_CWD));

        let (why, _, mtime) = &by_id["seconds"];
        assert_eq!(
            *why, "on deck",
            "seconds lastUpdatedAt must not age as 50 years"
        );
        assert!(
            now.saturating_sub(*mtime) < 10_000,
            "seconds timestamp converted to ms, got mtime={mtime}"
        );

        let (why, cwd, _) = &by_id["multiroot"];
        assert_eq!(*why, "on deck");
        assert_eq!(
            cwd.as_deref().map(norm_path),
            Some(norm_path(&ws_app.to_string_lossy()))
        );

        let (why, cwd, _) = &by_id["nofs"];
        assert_eq!(
            *why, "on deck",
            "workspaceIdentifier without fsPath uses the workspace.json map"
        );
        assert_eq!(
            cwd.as_deref().map(norm_path),
            Some(norm_path(&untracked.to_string_lossy()))
        );

        let (why, _, _) = &by_id["missing"];
        assert_eq!(*why, "folder missing");

        let (why, _, _) = &by_id["old"];
        assert_eq!(*why, "outside window");

        assert!(
            !by_id.contains_key("archived"),
            "archived composers stay out of cursor_rows_from_table"
        );

        ACTIVE_WINDOW.store(prev, std::sync::atomic::Ordering::Relaxed);
        let _ = fs::remove_dir_all(&untracked);
        let _ = fs::remove_dir_all(&ws_root);
    }

    #[test]
    fn cursor_titles_are_name_else_prompt_never_session() {
        assert_eq!(
            cursor_card_title(Some("Brain dump orchestration"), Some("ignored"), None),
            "Brain dump orchestration"
        );
        assert_eq!(
            cursor_card_title(
                Some(""),
                Some("Please fix the deck titles today extra words"),
                None
            ),
            "Please fix the deck titles today"
        );
        assert_eq!(
            cursor_card_title(None, None, Some("You are the primary orchestrator")),
            "You are the primary orchestrator"
        );
        let fallback = cursor_card_title(None, None, None);
        assert!(!fallback.to_ascii_uppercase().starts_with("SESSION"));
        assert_eq!(fallback, "Cursor");

        let text = concat!(
            r#"{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Tue</timestamp>\n<user_query>\nFix the session list\n</user_query>"}]}}"#,
            "\n"
        );
        assert_eq!(
            cursor_prompt_from_transcript(text).as_deref(),
            Some("Fix the session list")
        );

        let now = 1_789_500_000_000u64;
        let card = cursor_session_to_card(
            &CursorSession {
                bubble_count: 1,
                id: "abcdef123456".into(),
                cwd: CURSOR_AGENTS_CWD.into(),
                title: Some(cursor_card_title(None, None, None)),
                model: None,
                mtime: now - 1_000,
                running: false,
                mutable: false,
            },
            now,
        );
        let title = card.title.unwrap();
        assert!(!title.to_ascii_uppercase().starts_with("SESSION"));
        assert_eq!(title, "Cursor");
    }

    #[test]
    fn running_cursor_composer_stays_visible_outside_the_window() {
        let prev = active_window_ms();
        ACTIVE_WINDOW.store(
            CURSOR_CENSUS_WINDOW_MS,
            std::sync::atomic::Ordering::Relaxed,
        );
        let now = 1_789_500_000_000u64;
        let old = now - CURSOR_CENSUS_WINDOW_MS - 60_000;
        assert_eq!(
            cursor_composer_why(false, &CursorCwd::Agents, old, now, false),
            "outside window"
        );
        assert_eq!(
            cursor_composer_why(false, &CursorCwd::Agents, old, now, true),
            "on deck"
        );
        ACTIVE_WINDOW.store(prev, std::sync::atomic::Ordering::Relaxed);
    }

    /// Live machine census: every unarchived composer updated in the last 7 days
    /// and WHY the deck does or does not turn it into a card. Run with:
    ///   cargo test --lib live_cursor_census_print -- --ignored --nocapture
    #[test]
    #[ignore = "live machine snapshot — run with --ignored --nocapture"]
    fn live_cursor_census_print() {
        for line in cursor_live_census_lines(now_ms()) {
            println!("{line}");
        }
    }
}

#[cfg(test)]
mod tool_liveness_tests {
    use super::*;

    const MINUTE: u64 = 60 * 1000;

    #[test]
    fn an_open_app_with_no_recent_work_is_not_working() {
        // THE bug: `working: s.running` meant "Cursor is open", so QUILL orbited the brain
        // forever.
        assert!(!tool_session_working(true, 12 * 60 * MINUTE));
        assert_eq!(tool_session_status(true, 12 * 60 * MINUTE), "recent");
    }

    #[test]
    fn an_open_app_that_just_wrote_is_working() {
        assert!(tool_session_working(true, 30 * 1000));
        assert_eq!(tool_session_status(true, 30 * 1000), "live");
    }

    #[test]
    fn a_closed_app_is_never_working_however_fresh_the_file() {
        // `working` is what drives the orbit and the firing count, and it is
        // false regardless of how recently the file was touched.
        assert!(!tool_session_working(false, 0));
        assert!(!tool_session_working(false, WORKING_STALE_MS / 2));
        // NOTE: `status` for a closed session falls through to `liveness(age)`,
        // which does still say "live" for a very fresh file. That is the deck's
        // pre-existing recency wording shared with the Claude lane, not a claim
        // that a prompt is running - deliberately left alone here.
        assert_eq!(tool_session_status(false, 0), liveness(0));
    }

    #[test]
    fn the_boundary_is_the_same_one_the_claude_lane_uses() {
        // One definition of "working" across all three tools, or the deck goes
        // back to meaning different things in different columns.
        assert!(tool_session_working(true, WORKING_STALE_MS - 1));
        assert!(!tool_session_working(true, WORKING_STALE_MS));
    }

    #[test]
    fn an_idle_but_open_session_still_appears_on_the_deck() {
        // It belongs in the sidebar - it just must not orbit. "recent", not gone.
        assert_eq!(tool_session_status(true, 60 * MINUTE), "recent");
    }
}

#[cfg(test)]
mod codex_discovery_probe {
    use super::*;

    /// DIAGNOSTIC against the real ~/.codex on this machine. Ignored by default so
    /// CI never depends on the owner's home directory; run with:
    ///   cargo test --lib codex_discovery_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn what_does_the_real_scan_actually_find() {
        let now = now_ms();
        let mut tracked: HashSet<String> = HashSet::new();
        tracked.insert(norm_path(r"C:\Users\dev\Desktop\praxis"));
        tracked.insert(norm_path(r"C:\Users\dev\Desktop\command-deck"));

        let with_filter = codex_sessions(&tracked, now);
        let unfiltered = codex_sessions(&HashSet::new(), now);

        println!("codex_home        = {:?}", codex_home());
        println!("process_alive     = {}", codex_process_alive());
        println!("tracked filter ON : {} sessions", with_filter.sessions.len());
        println!("tracked filter OFF: {} sessions", unfiltered.sessions.len());
        println!("hidden outside window: {}", unfiltered.hidden_older);
        for s in unfiltered.sessions.iter().take(12) {
            println!(
                "  id={} age={}s running={} cwd={}",
                &s.id[..s.id.len().min(8)],
                now.saturating_sub(s.mtime) / 1000,
                s.running,
                s.cwd
            );
        }
    }
}

#[cfg(test)]
mod account_scoping_tests {
    use super::*;

    #[test]
    fn only_the_main_address_is_allowlisted() {
        assert!(email_is_allowed("deckowner@example.com"));
        assert!(
            email_is_allowed("DeckOwner@Example.com"),
            "case must not matter"
        );
        assert!(!email_is_allowed("deckowner1@example.com"));
        assert!(!email_is_allowed("deckown@example.com"));
        assert!(!email_is_allowed("deckown"));
    }

    #[test]
    fn the_signed_in_account_is_never_hidden() {
        assert!(email_is_allowed("deckowner@example.com"));
    }

    #[test]
    fn other_addresses_are_still_excluded() {
        assert!(!email_is_allowed("owner@example.edu"));
        assert!(
            !email_is_allowed("owner@example.edu"),
            "the same name on another domain is a different account"
        );
        assert!(!email_is_allowed("someone.else@example.com"));
        assert!(!email_is_allowed("adams@example.com"));
        assert!(!email_is_allowed(""));
    }

    #[test]
    fn a_near_miss_local_part_does_not_slip_through() {
        assert!(!email_is_allowed("deckownr@example.com"));
        assert!(!email_is_allowed("deckowner1x@example.com"));
        assert!(!email_is_allowed("xdeckowner@example.com"));
    }
}

#[cfg(test)]
mod rebuild_latch_tests {
    use super::*;

    #[test]
    fn a_subprocess_that_overruns_is_killed_and_reads_as_no_data() {
        // The exact failure: a child that never exits must not hang the caller.
        #[cfg(windows)]
        let cmd = {
            let mut c = std::process::Command::new("powershell");
            c.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
            c
        };
        #[cfg(not(windows))]
        let cmd = {
            let mut c = std::process::Command::new("sleep");
            c.arg("30");
            c
        };
        let started = std::time::Instant::now();
        let out = output_with_timeout(cmd, std::time::Duration::from_millis(800));
        assert!(out.is_none(), "an overrun must return None, not block");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_fast_subprocess_returns_its_output() {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("--version");
        let out = output_with_timeout(cmd, std::time::Duration::from_secs(10)).expect("git runs");
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout)
            .to_lowercase()
            .contains("git"));
    }

    #[test]
    fn a_process_inventory_probe_has_a_hard_deadline() {
        assert!(
            PROCESS_PROBE_TIMEOUT <= std::time::Duration::from_secs(5),
            "a process inventory probe may not hold a Flight Deck rebuild beyond five seconds"
        );
    }

    #[test]
    fn rebuild_lease_covers_the_bounded_git_work() {
        // Each refreshed lane runs merge-base, numstat, and rev-list.
        let git_budget_ms = GIT_TIMEOUT.as_millis() as u64 * DIFF_SHELL_BUDGET as u64 * 3;
        assert!(
            REBUILD_LEASE_MS > git_budget_ms,
            "the takeover lease must not overlap a rebuild still inside its bounded git budget"
        );
    }

    #[test]
    fn a_panicking_rebuild_still_releases_the_flag() {
        let _serial = rebuild_test_guard();
        reset_rebuild_state();
        let (lease, _) = claim_rebuild(1_000, false).expect("first rebuild owns the slot");
        let handle = std::thread::spawn(move || {
            let _lease = lease;
            panic!("simulated rebuild failure");
        });
        assert!(handle.join().is_err(), "the thread really panicked");
        assert!(
            !rebuild_in_flight(),
            "a panic used to leave the flag true forever and freeze the deck"
        );
    }

    #[test]
    fn a_superseded_rebuild_cannot_release_its_successors_flag() {
        let _serial = rebuild_test_guard();
        reset_rebuild_state();
        let (old, _) = claim_rebuild(1_000, false).expect("old rebuild owns the slot");
        let (new, _) = claim_rebuild(2_000, true).expect("force supersedes the old rebuild");
        drop(old);
        assert!(
            rebuild_in_flight(),
            "a presumed-dead rebuild finishing late must not clear the live one's flag"
        );
        drop(new);
        assert!(!rebuild_in_flight());
    }

    #[test]
    fn concurrent_window_polls_start_exactly_one_rebuild() {
        let _serial = rebuild_test_guard();
        reset_rebuild_state();
        let start = std::sync::Arc::new(std::sync::Barrier::new(16));
        let claimed = std::sync::Arc::new(std::sync::Barrier::new(16));
        let mut workers = Vec::new();
        for _ in 0..16 {
            let start = start.clone();
            let claimed = claimed.clone();
            workers.push(std::thread::spawn(move || {
                start.wait();
                let lease = claim_rebuild(1_000, false).map(|(lease, _)| lease);
                // Keep the winning lease alive until every contender has tried.
                claimed.wait();
                let won = lease.is_some();
                drop(lease);
                won
            }));
        }
        let winners = workers
            .into_iter()
            .map(|worker| worker.join().expect("contender does not panic"))
            .filter(|won| *won)
            .count();
        assert_eq!(winners, 1, "only one window may own the rebuild slot");
        assert!(!rebuild_in_flight());
    }

    fn rebuild_test_guard() -> std::sync::MutexGuard<'static, ()> {
        static SERIAL: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        SERIAL
            .get_or_init(|| std::sync::Mutex::new(()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn reset_rebuild_state() {
        *REBUILD_STATE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = RebuildState::default();
    }

    fn rebuild_in_flight() -> bool {
        REBUILD_STATE
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .in_flight
    }
}

#[cfg(test)]
mod desktop_account_tests {
    use super::*;
    use std::collections::BTreeMap;

    const DESKTOP: &str = "00000000-0000-4000-8000-000000000001";
    const CLI: &str = "00000001-0000-0000-0000-000000000000";
    const THIRD: &str = "00000002-0000-0000-0000-000000000000";

    fn recs() -> Vec<String> {
        vec![
            format!("{DESKTOP}/org-a"),
            format!("{DESKTOP}/org-b"),
            format!("{CLI}/org-a"),
            format!("{THIRD}/org-q"),
        ]
    }

    #[test]
    fn the_desktop_account_is_admitted_even_when_the_ledger_never_learned_it() {
        // The real 2026-09-13 state: the ledger knew only the CLI's account, and the
        // sidebar's account was filtered off the deck entirely.
        let mut ledger = BTreeMap::new();
        ledger.insert(format!("{CLI}/org-a"), "deckowner@example.com".to_string());
        let r = recs();
        let keys = desktop_account_keys(r.iter().map(String::as_str), Some(DESKTOP), &ledger);
        assert!(keys.contains(&format!("{DESKTOP}/org-a")));
        assert!(
            keys.contains(&format!("{DESKTOP}/org-b")),
            "every org under the account"
        );
        assert!(
            !keys.contains(&format!("{CLI}/org-a")),
            "this function only speaks for the desktop account"
        );
        assert!(!keys.iter().any(|k| k.starts_with(THIRD)));
    }

    #[test]
    fn a_signed_in_desktop_account_is_always_admitted() {
        let mut ledger = BTreeMap::new();
        ledger.insert(format!("{THIRD}/org-q"), "owner@example.edu".to_string());
        let r = recs();
        let keys = desktop_account_keys(r.iter().map(String::as_str), Some(THIRD), &ledger);
        assert!(
            keys.contains(&format!("{THIRD}/org-q")),
            "active unknown account is admitted: {keys:?}"
        );
    }

    #[test]
    fn no_desktop_config_admits_nothing_from_this_path() {
        let r = recs();
        assert!(
            desktop_account_keys(r.iter().map(String::as_str), None, &BTreeMap::new()).is_empty()
        );
        assert!(
            desktop_account_keys(r.iter().map(String::as_str), Some(""), &BTreeMap::new())
                .is_empty()
        );
    }
}

#[cfg(test)]
mod deck_title_and_filter_tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::io::Write;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("praxis-deck-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_jsonl(path: &Path, lines: &[&str]) {
        let mut f = fs::File::create(path).unwrap();
        for line in lines {
            writeln!(f, "{line}").unwrap();
        }
    }

    #[test]
    fn full_uuid_from_stem_and_card_id_suffix() {
        let uuid = "00000000-0000-7000-8000-00000000000c";
        let stem = format!("rollout-2026-09-14T18-17-00-{uuid}");
        assert_eq!(codex_uuid_from_stem(&stem), uuid);
        assert_eq!(codex_card_id_suffix(uuid), "00000000000c");
    }

    #[test]
    fn title_hits_session_index_by_full_filename_uuid() {
        let uuid = "01a0aaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let mut index = HashMap::new();
        index.insert(uuid.to_string(), "My Real Thread Name".into());
        let title = resolve_codex_title(
            &index,
            uuid,
            None,
            Some("<recommended_plugins>"),
            "C:/repos/praxis",
            "eeeeeeeeeeee",
        );
        assert_eq!(title, "My Real Thread Name");
    }

    #[test]
    fn title_hits_session_index_by_session_meta_id() {
        let file_uuid = "01a0bbbb-bbbb-cccc-dddd-ffffffffffff";
        let meta_id = "01a0cccc-bbbb-cccc-dddd-111111111111";
        let mut index = HashMap::new();
        index.insert(meta_id.to_string(), "Title From Meta Id".into());
        let title = resolve_codex_title(
            &index,
            file_uuid,
            Some(meta_id),
            None,
            "C:/repos/praxis",
            "ffffffffffff",
        );
        assert_eq!(title, "Title From Meta Id");
    }

    #[test]
    fn first_prompt_skips_injected_blocks_and_takes_real_user_text() {
        let dir = tmp_dir("prompt-skip");
        let p = dir.join("rollout.jsonl");
        write_jsonl(
            &p,
            &[
                r#"{"type":"session_meta","payload":{"id":"u1","cwd":"C:/x"}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<recommended_plugins>\nNope"}]}}"#,
                r##"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for this project"}]}}"##,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd</environment_context>"}]}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<user_instructions>be brief</user_instructions>"}]}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Please fix the deck titles for Codex sessions today"}]}}"#,
            ],
        );
        let got = codex_first_prompt(&p).expect("real prompt");
        assert!(got.to_ascii_lowercase().contains("fix the deck"), "{got}");
        assert!(!got.contains("recommended_plugins"), "{got}");
    }

    #[test]
    fn first_prompt_extracts_realtime_delegation_input() {
        let dir = tmp_dir("realtime");
        let p = dir.join("rollout.jsonl");
        write_jsonl(
            &p,
            &[
                r#"{"type":"session_meta","payload":{"id":"u1","cwd":"C:/x"}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<realtime_delegation><input>Open the Flight Deck window now</input></realtime_delegation>"}]}}"#,
            ],
        );
        let got = codex_first_prompt(&p).expect("input text");
        assert!(
            got.to_ascii_lowercase().contains("open the flight"),
            "{got}"
        );
    }

    #[test]
    fn first_prompt_prefers_event_msg_user_message() {
        let dir = tmp_dir("event-msg");
        let p = dir.join("rollout.jsonl");
        write_jsonl(
            &p,
            &[
                r#"{"type":"session_meta","payload":{"id":"u1","cwd":"C:/x"}}"#,
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Response item comes first but should lose"}]}}"#,
                r#"{"type":"event_msg","payload":{"type":"user_message","message":"Event message is the preferred title source"}}"#,
            ],
        );
        let got = codex_first_prompt(&p).expect("event_msg");
        assert!(got.to_ascii_lowercase().contains("event message"), "{got}");
        assert!(!got.to_ascii_lowercase().contains("response item"), "{got}");
    }

    #[test]
    fn subagent_does_not_fabricate_parent_turn_activity() {
        let parent = CodexSession {
            owner: SessionOwner::Zach,
            id: "aaaaaaaaaaaa".into(),

            cwd: "C:/repos/praxis".into(),
            title: Some("Parent Session".into()),
            model: None,
            mtime: 100,
            running: false,
        };
        let child = CodexSession {
            owner: SessionOwner::Subagent,
            id: "bbbbbbbbbbbb".into(),

            cwd: "C:/repos/praxis".into(),
            title: Some("Ohm Subagent".into()),
            model: None,
            mtime: 200,
            running: true,
        };
        let out = finalize_codex_sessions(vec![parent, child]);
        assert_eq!(
            out.len(),
            2,
            "reader retains all owners for the pure visibility pass"
        );
        assert!(
            !out.iter()
                .find(|s| s.owner == SessionOwner::Zach)
                .unwrap()
                .running,
            "a child never fabricates a turn on its parent"
        );
    }

    #[test]
    fn exec_tool_history_does_not_change_ownership() {
        let probe = CodexSession {
            owner: SessionOwner::Praxis,
            id: "cccccccccccc".into(),

            cwd: "C:/repos/praxis".into(),
            title: Some("Reply with exactly the word READY".into()),
            model: None,
            mtime: 50,
            running: false,
        };
        let kept = CodexSession {
            owner: SessionOwner::Praxis,
            id: "dddddddddddd".into(),

            cwd: "C:/repos/praxis".into(),
            title: Some("Exec with a tool".into()),
            model: None,
            mtime: 60,
            running: false,
        };
        let out = finalize_codex_sessions(vec![probe, kept]);
        assert_eq!(
            out.len(),
            2,
            "tool history does not decide ownership or visibility"
        );
        assert!(out.iter().all(|s| s.owner == SessionOwner::Praxis));
    }

    #[test]
    fn main_address_admitted_across_orgs_retired_one_hidden_unless_active() {
        let acct_main = "00000001-0000-0000-0000-000000000007";
        let acct_other = "00000000-0000-0000-0000-000000000071";
        let third = "00000002-0000-0000-0000-000000000003";
        let unknown_signed = "aabbccdd-0000-0000-0000-unknown00001";

        let mut ledger = BTreeMap::new();
        ledger.insert(
            format!("{acct_main}/org-a"),
            "deckowner@example.com".to_string(),
        );
        ledger.insert(
            format!("{acct_other}/org-x"),
            "deckowner1@example.com".to_string(),
        );
        ledger.insert(format!("{third}/org-q"), "owner@example.edu".to_string());

        let recs = vec![
            Record {
                cli_session_id: "s1".into(),
                cwd: "C:/a".into(),
                title: None,
                model: None,
                effort: None,
                is_archived: false,
                last_activity_at: 1,
                account: format!("{acct_main}/org-b"),
            },
            Record {
                cli_session_id: "s2".into(),
                cwd: "C:/b".into(),
                title: None,
                model: None,
                effort: None,
                is_archived: false,
                last_activity_at: 1,
                account: format!("{acct_other}/org-x"),
            },
            Record {
                cli_session_id: "s3".into(),
                cwd: "C:/c".into(),
                title: None,
                model: None,
                effort: None,
                is_archived: false,
                last_activity_at: 1,
                account: format!("{third}/org-q"),
            },
            Record {
                cli_session_id: "s4".into(),
                cwd: "C:/d".into(),
                title: None,
                model: None,
                effort: None,
                is_archived: false,
                last_activity_at: 1,
                account: format!("{unknown_signed}/org-z"),
            },
        ];

        let allowed_uuids: HashSet<String> = ledger
            .iter()
            .filter(|(_, e)| email_is_allowed(e))
            .filter_map(|(k, _)| k.split('/').next().map(|s| s.to_string()))
            .collect();
        assert!(allowed_uuids.contains(acct_main));
        // Retired 2026-10-04: no longer on the allowlist.
        assert!(!allowed_uuids.contains(acct_other));

        let mut keys = HashSet::new();
        keys.insert(String::new());
        for uuid in &allowed_uuids {
            admit_account_uuid(&mut keys, uuid, &recs, &ledger);
        }
        keys.extend(desktop_account_keys(
            recs.iter().map(|r| r.account.as_str()),
            Some(unknown_signed),
            &ledger,
        ));

        assert!(
            keys.contains(&format!("{acct_main}/org-b")),
            "main account in second org"
        );
        assert!(
            !keys.contains(&format!("{acct_other}/org-x")),
            "retired 0071, not signed in → hidden"
        );
        assert!(
            keys.contains(&format!("{unknown_signed}/org-z")),
            "signed-in unknown admitted"
        );
        assert!(
            !keys.contains(&format!("{third}/org-q")),
            "inactive account stays hidden"
        );

        let back = desktop_account_keys(recs.iter().map(|r| r.account.as_str()), Some(acct_other), &ledger);
        assert!(back.contains(&format!("{acct_other}/org-x")), "0071 signed in again → admitted");

        let email = email_for_account_key(&format!("{third}/org-q"), &ledger);
        assert_eq!(email, "owner@example.edu");
        let unknown = email_for_account_key("no-such/org", &BTreeMap::new());
        assert_eq!(unknown, "unknown account");
    }

    #[test]
    fn folder_title_last_resort_is_lowercase() {
        let t = resolve_codex_title(
            &HashMap::new(),
            "01a0zzzz-0000-0000-0000-ffffffffffff",
            None,
            None,
            r"C:\Users\dev\Desktop\praxis",
            "ffffffffffff",
        );
        assert_eq!(t, "praxis · ffffff");
    }

    #[test]
    #[ignore = "live machine cold-start budget — run with --ignored --nocapture"]
    fn live_cold_snapshot_finishes_within_five_seconds() {
        let started = std::time::Instant::now();
        let snapshot = build_snapshot_with(&HashSet::new(), false);
        let elapsed = started.elapsed();
        eprintln!(
            "COLD_SNAPSHOT elapsed_ms={} repos={} active={} running={} hidden_older={}",
            elapsed.as_millis(),
            snapshot.repos.len(),
            snapshot.active_count,
            snapshot.running_count,
            snapshot.hidden_older
        );
        assert!(snapshot.error.is_none(), "cold snapshot must be truthful");
        assert!(
            elapsed <= std::time::Duration::from_secs(5),
            "cold snapshot took {}ms",
            elapsed.as_millis()
        );
    }

    #[test]
    #[ignore = "live machine performance profile — run with --ignored --nocapture"]
    fn live_cold_snapshot_phase_profile() {
        fn timed<T>(label: &str, f: impl FnOnce() -> T) -> T {
            let started = std::time::Instant::now();
            let value = f();
            eprintln!("PROFILE {label} {}ms", started.elapsed().as_millis());
            value
        }

        let now = now_ms();
        let recs = timed("claude_records", read_records);
        let running = timed("process_census", running_pids);
        let _spawn_records = timed("spawn_records", read_spawned_records);
        let _spawned = timed("spawned_pids", spawned_pids);
        let _projects_dir = timed("projects_dir", projects_dir);
        let _accounts = timed("account_keys", || current_account_keys(&recs, now));
        let _ledger = timed("account_ledger", read_account_ledger);
        let every_folder = HashSet::new();
        let _codex = timed("codex_store", || codex_sessions(&every_folder, now));
        let _cursor = timed("cursor_store", || cursor_sessions(&every_folder, now));
        let _projects = timed("project_registry", || project_registry(false));
        let _snapshot = timed("warm_snapshot_total", || {
            build_snapshot_with(&HashSet::new(), false)
        });
        assert!(!running.is_empty(), "the live process census should not be empty");
    }

    #[test]
    #[ignore = "live machine snapshot — run with --ignored --nocapture"]
    fn live_deck_titles_print() {
        let snap = build_snapshot_with(&HashSet::new(), false);
        for repo in &snap.repos {
            for lane in &repo.lanes {
                for s in &lane.sessions {
                    println!(
                        "{} | {} | {}",
                        lane.driver,
                        s.status,
                        s.title.as_deref().unwrap_or("(no title)")
                    );
                }
            }
        }
        println!(
            "hidden_older={} hidden_other_account={} hidden_subagents={} hidden_probes={}",
            snap.hidden_older, snap.hidden_other_account, snap.hidden_subagents, snap.hidden_probes
        );
        for h in &snap.hidden_accounts {
            println!("hidden_account email={} count={}", h.email, h.count);
        }
        let titles: Vec<String> = snap
            .repos
            .iter()
            .flat_map(|r| r.lanes.iter())
            .flat_map(|l| l.sessions.iter())
            .filter_map(|s| s.title.clone())
            .collect();
        eprintln!("card_count={}", titles.len());
        let probeish = titles.iter().any(|t| {
            let l = t.to_ascii_lowercase();
            l.contains("reply with exactly the word ready") || l == "ready" || l == "ok"
        });
        if probeish {
            eprintln!("WARN: probe-like title still present");
        }
        let session_fallback = titles.iter().filter(|t| t.starts_with("SESSION ")).count();
        eprintln!("SESSION_fallback_count={session_fallback}");
    }
}

#[cfg(test)]
mod off_sidebar_account_tests {
    use super::*;

    fn rec(account: &str, id: &str, last: u64) -> Record {
        Record {
            cli_session_id: id.into(),
            cwd: "C:/Users/dev/Desktop/praxis".into(),
            title: None,
            model: None,
            effort: None,
            is_archived: false,
            last_activity_at: last,
            account: account.into(),
        }
    }

    #[test]
    fn signed_in_account_keeps_the_sidebar_rule_and_others_get_the_window() {
        let day = 24 * 60 * 60 * 1000;
        let now = 100 * day;
        let signed: HashSet<String> = ["desk-uuid".to_string()].into_iter().collect();
        let running: HashMap<String, u32> = [("live".to_string(), 7u32)].into_iter().collect();
        assert!(!claude_record_outside_window(&rec("desk-uuid/org", "a", now - 30 * day), &signed, day, now, &running));
        // Another admitted account: hidden once older than the window…
        assert!(claude_record_outside_window(&rec("old-uuid/org", "b", now - 3 * day), &signed, day, now, &running));
        // …but kept inside it, when running, and under "All".
        assert!(!claude_record_outside_window(&rec("old-uuid/org", "c", now - day / 2), &signed, day, now, &running));
        assert!(!claude_record_outside_window(&rec("old-uuid/org", "live", now - 30 * day), &signed, day, now, &running));
        assert!(!claude_record_outside_window(&rec("old-uuid/org", "d", now - 30 * day), &signed, 0, now, &running));
        assert!(!claude_record_outside_window(&rec("", "e", 0), &signed, day, now, &running));
        assert!(!claude_record_outside_window(&rec("old-uuid/org", "f", 0), &HashSet::new(), day, now, &running));
    }
}
