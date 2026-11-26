// Mirrors the Tauri command contract (src-tauri/src/flightdeck.rs).
//
// THE MODEL (worktree-aware): a REPO is a group → it holds LANES → a LANE holds
// SESSIONS. A lane is one git worktree on its own branch, OR a declared remote
// cloud lane. A session attaches to whichever lane (working dir) it's rooted in.
// Two sessions in DIFFERENT worktrees of one repo = healthy parallelism. The only
// alarm is a COLLISION: 2+ live build sessions in the SAME working dir.

export type Liveness = 'live' | 'recent' | 'dormant';

// Who drives a lane. Distinct tokens per type; 'integration' is the merge target.
export type Driver = 'integration' | 'max' | 'cursor' | 'codex' | 'cloud' | 'claude';

export type LaneKind = 'worktree' | 'cloud' | 'mission-control';

export type SessionOwner = 'zach' | 'praxis' | 'automation' | 'subagent' | 'probe' | 'placeholder';

export interface SessionCard {
  owner: SessionOwner;
  activity: 'running' | 'active';
  cwd: string;
  id: string; // cliSessionId
  title: string | null; // the session's name from Claude's session manager
  status: Liveness;
  ageMs: number;
  mtime: number;
  model: string | null;
  modelLabel: string | null;
  effort: string | null;
  preview: string | null;
  branch: string | null;
  /** The session is OPEN - a live process, i.e. it is in Claude Code's sidebar.
   *  NOT the same as "a prompt is running": a window left open at an empty prompt
   *  is `running` all day. */
  running: boolean;
  /** A prompt is ACTUALLY EXECUTING right now (assistant generating, or a tool it
   *  asked for still running). Derived backend-side from the transcript's last
   *  turn record. This is the ONLY thing that should make an agent orbit the
   *  brain or count toward LIVE / FIRING. */
  working?: boolean;
  /** Who started this session: 'praxis' (Praxis spawned it - its pid is in the
   *  spawn registry) or 'manual' (the owner's own hands). Replaces a localStorage id
   *  set that could never match, which made EVERY session read as manual. */
  origin?: 'praxis' | 'manual';
  /** OS pid of the live process, from Claude's own session registry
   *  (~/.claude/sessions/*.json, liveness-checked). Present for a RUNNING Claude
   *  session whether Praxis spawned it or the owner started it by hand; absent for
   *  codex/cursor, which have no pid registry to stop from. Drives the deck's
   *  STOP control. */
  pid?: number | null;
  role: 'build' | 'passive'; // 'build' = has edited repo files; 'passive' = orchestrator/research
  // A trailing un-answered tool request near the transcript EOF - a REAL approval
  // gate a live interactive session is parked on (only ever set for running+recent
  // sessions; headless skip-permission sessions never sit here). Absent otherwise.
  wants?: string | null;
}

// Real per-lane git divergence vs the repo's base/integration branch.
export interface LaneDiff {
  added: number; // inserted lines across changed files
  deleted: number; // deleted lines
  files: number; // files touched
  ahead: number; // commits on this lane's HEAD not yet in the base branch
  /** Files with UNCOMMITTED changes right now (`git status --porcelain`).
   *  Absent on an older backend - render no cleanliness claim rather than guess. */
  dirtyFiles?: number;
}

export interface Lane {
  id: string; // encoded worktree path (stable key, matches ~/.claude/projects + vault keys)
  label: string; // lane role/name (e.g. "Integration", "Lane A", "Cursor")
  path: string | null; // the worktree's working dir; null for a remote/cloud lane
  branch: string | null;
  head: string | null;
  driver: Driver;
  port: number | null; // dev-server port (from the lanes manifest), when known
  kind: LaneKind;
  isIntegration: boolean; // the merge target the other lanes flow into
  remote: boolean; // off-machine (cloud) - no local sessions
  readOnly: boolean;
  autoReadOnly: boolean;
  userReadOnly: boolean;
  background: boolean;
  liveCount: number; // running now
  recentCount: number; // active < 30 min, not running
  archivedCount: number; // archived sessions rooted in this lane
  liveBuilderCount: number; // running sessions actually editing files
  collision: boolean; // 2+ live build sessions in THIS working dir
  sessions: SessionCard[];
  overflow: number; // additional non-archived sessions not shown
  diff?: LaneDiff | null; // real +adds/−dels/files/ahead vs base branch; absent for cloud/codex/cursor lanes
}

export interface Repo {
  id: string; // encoded main-worktree path (stable repo identity)
  label: string; // pretty repo name (e.g. "Catalyzed Alpha")
  root: string; // main worktree path
  laneCount: number;
  runningLaneCount: number; // lanes with a live session right now
  activeLaneCount: number; // lanes with a live OR recent session
  liveCount: number;
  recentCount: number;
  archivedCount: number;
  collision: boolean; // any lane in a real same-dir collision
  parallel: boolean; // 2+ lanes running at once, no collision → healthy parallelism
  hasFleet: boolean; // more than one lane (a real worktree fleet)
  lanes: Lane[];
}

export interface HiddenAccount {
  email: string;
  count: number;
}

export interface SessionGroup {
  id: string;
  label: string;
  root: string;
  sessions: SessionCard[];
}

export interface LanesSnapshot {
  groups: SessionGroup[];
  activeCount: number;
  runningCount: number;
  hiddenPraxis: number;
  hiddenAutomation: number;
  hiddenPlaceholders: number;
  generatedAt: number;
  projectsDir: string;
  repos: Repo[];
  /** The ACTIVE WINDOW this snapshot was built with, in ms. 0 = no time filter.
   *  A session is on the deck iff it is unarchived, on a current Claude account,
   *  and either running or last active within this window. */
  activeWindowMs: number;
  /** Unarchived sessions on a current account that fell outside the window.
   *  Rendered as a real count so the filter is never a silent truncation. */
  hiddenOlder: number;
  /** Unarchived sessions belonging to a Claude account that is no longer signed
   *  in - invisible in Claude Code's own sidebar too, so shown only as a count.
   *  Equals the sum of `hiddenAccounts[].count`. */
  hiddenOtherAccount: number;
  /** Per-email breakdown of Claude sessions kept off the deck by the account rule. */
  hiddenAccounts?: HiddenAccount[];
  /** Codex sub-agent rollouts folded into their parent card. */
  hiddenSubagents?: number;
  /** Idle `codex_exec` health probes with no tool calls. */
  hiddenProbes?: number;
  /** Every operator lane lock currently set, by lane id. Lets a lane that exists
   *  only in the topology scan (a quiet repo) show its real lock state - those
   *  lanes are absent from `repos[].lanes`, so their lock had nowhere to come
   *  back from and the chip silently reverted on reload. */
  readOnlyLanes?: string[];
  error?: string;
}

// NOTE: the v2 per-lane prompt vault (VaultEntry/Vault/FireStatus/MODEL_OPTIONS/
// EFFORT_OPTIONS) and the v2 mission-tree hierarchy (MissionTask/MissionGroup)
// were removed here as dead code along with the v2 components/hooks that were
// their only consumers. The v3 deck uses its own GLOBAL prompt vault (PvEntry in
// deck/useDeckVault.ts) and its own fleet/effort roster (FLEET_MODELS/EFFORTS in
// deck/model.ts) instead.

// ── Static worktree/code-lane topology diagram (on-demand, not polled) ──
// Mirrors src-tauri/src/flightdeck_topology.rs's TopologySnapshot exactly.
export interface TopologyWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  label: string;
  isMain: boolean;
}

export interface TopologyRepo {
  id: string;
  label: string;
  root: string;
  worktrees: TopologyWorktree[];
}

export interface TopologySnapshot {
  generatedAt: number;
  repos: TopologyRepo[];
}
