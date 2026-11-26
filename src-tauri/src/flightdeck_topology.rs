// Flight Deck v2 - STATIC worktree/code-lane topology diagram.
//
// Unlike `flightdeck::fd_sessions` (which only surfaces a repo/lane once it has a
// live/recent Claude session, polled every few seconds), this command is an
// ON-DEMAND, organization-only snapshot: "here is every project, and every git
// worktree/lane that exists under it right now" - regardless of whether anything
// is currently running there. It's meant to back a pull-out diagram the owner opens to
// see how the work is laid out, not a live-refreshing dashboard, so the caller
// should fetch it once (or on a manual "rebuild" click), never poll it.
//
// Uses flightdeck's shared cached registry: direct Desktop git roots, their
// worktrees, and the folders in each project's sibling lanes directory.

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TopologyWorktree {
    pub(crate) path: String,
    pub(crate) branch: Option<String>,
    pub(crate) head: Option<String>,
    /// The folder basename (e.g. "lane-a", "w3-a") - a stable, short label.
    pub(crate) label: String,
    pub(crate) is_main: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TopologyRepo {
    pub(crate) id: String, // normalized main-worktree path - matches flightdeck::Repo.id
    pub(crate) label: String,
    pub(crate) root: String,
    pub(crate) worktrees: Vec<TopologyWorktree>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologySnapshot {
    pub(crate) generated_at: u64,
    pub(crate) repos: Vec<TopologyRepo>,
}

/// On-demand static snapshot of every known project's git worktree topology.
/// NOT meant to be polled - call once when the diagram is opened, or on a manual
/// "rebuild" action. Never throws: a repo root that can't be resolved (missing,
/// not a git repo, git unavailable) is simply omitted from `repos`.
///
/// ASYNC + spawn_blocking: the shared registry shells out to `git worktree list` for each
/// project root. On the sync IPC thread that blocked the Tauri bridge (and the main
/// window's close handler) whenever git was slow - which is exactly why the Rebuild
/// button could sit at "Rebuilding…" and the X felt stuck. Moving the git work to the
/// blocking pool keeps the IPC/UI thread free (same pattern as `fd_sessions`).
#[tauri::command]
pub async fn fd_worktree_topology() -> TopologySnapshot {
    tokio::task::spawn_blocking(crate::flightdeck::project_topology)
        .await
        .unwrap_or_else(|_| TopologySnapshot {
            generated_at: crate::flightdeck::now_ms(),
            repos: vec![],
        })
}
