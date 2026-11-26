/**
 * Shared agent roster - the single source of the "who's working" fleet, consumed by
 * BOTH secondary windows: the Memory Galaxy's Agent Dashboard side panel and the
 * Command Center cockpit. (The brain window has its own in-scene roster off the live
 * mock timeline; this module is for the DOM windows that don't run that timeline.)
 *
 * Phase-1 contract: never blank, always filmable. It seeds a premium mock fleet so a
 * pop-out window opened cold still reads alive. When running under Tauri it ALSO folds
 * in the REAL Claude sessions Flight Deck already reads (`fd_sessions`) + the live
 * session-state bus, so the same surface reflects actual work the moment there is any.
 * No new backend, zero spend - it's the filmable front-end over data we already have.
 *
 * HUE = model identity (via brain/modelTint), LUMINANCE = work-state - the exact rule
 * the brain roster uses, so scene ↔ windows read as one system.
 */
import { eventBus } from "@/data/eventBus";
import { useSyncExternalStore } from "react";
import { modelFamily, MODEL_LABEL, MODEL_TINT, type ModelFamily } from "@/brain/modelTint";
import { visibleInterval } from "@/shared/visibility";
import type { Driver, LanesSnapshot, SessionCard } from "@/flightdeck/types";

export type AgentStatus = "working" | "idle" | "done";

export interface AgentRow {
  id: string;
  name: string;
  /** Raw model id/string → resolved to a family + tint via modelTint. null = theme accent. */
  model: string | null;
  family: ModelFamily | null;
  status: AgentStatus;
  role: string; // builder · reviewer · orchestrator · scout · designer
  task: string | null; // current focus, one line
  thought: string | null; // latest reasoning / preview line
  lane: string | null; // worktree branch or remote lane
  /** Memory clusters / Praxis areas this agent is touching (galaxy tie-in copy). */
  touches: string[];
  live: boolean; // true = a real Claude session, false = the seeded mock fleet
  /** Current task progress 0..1 - drives the galaxy rig's progress hairline + the
   *  Inspector/Fleet progress bars. Sourced from real task:progress events; 0 when unknown. */
  prog: number;
  /** Is `prog` an actual MEASUREMENT? The fd_sessions snapshot carries no per-task
   *  percentage, so a session-derived row sets this false and every surface must
   *  then show a state ("in flight"), never a number. Rendering a coarse
   *  running/passive proxy as "Task 50%" is a fabricated fact - it read as a live
   *  measurement while being the same constant for every agent, forever. */
  progKnown: boolean;
  /** The graph node the agent is currently focused on (a node id OR a node label the
   *  galaxy resolves to a node). null when the agent is idle / not on any node. */
  focus: string | null;
}

export interface AgentIdentity {
  key: string;
  id: string;
  name: string;
  role: string;
}

const SESSION_AGENT_IDENTITY: Record<string, AgentIdentity> = {
  forge: { key: "forge", id: "a.forge", name: "Forge", role: "claude code" },
  vega: { key: "vega", id: "a.vega", name: "Vega", role: "codex" },
  quill: { key: "quill", id: "a.quill", name: "Quill", role: "cursor" },
  hermes: { key: "hermes", id: "a.hermes", name: "Hermes", role: "brain engine" },
};

/**
 * Which fleet codename a live roster row's MODEL FAMILY reports under.
 *
 * Only the four Anthropic families answer "forge" now. This used to end in a
 * catch-all `if (family) return "forge"`, which claimed every model it did not
 * recognise for Claude Code - a guess wearing the same clothes as a fact.
 */
export function codenameForFamily(family: ModelFamily | null): string | null {
  if (family === "codex") return "vega";
  if (family === "cursor") return "quill";
  if (family === "hermes") return null; // the brain's own engine rows
  if (family === "opus" || family === "sonnet" || family === "haiku" || family === "fable") {
    return "forge";
  }
  return null;
}

/** Which fleet codename the TOOL that spawned this session reports under. */
function codenameForDriver(driver: Driver): string | null {
  if (driver === "codex") return "vega";
  if (driver === "cursor") return "quill";
  // `cloud` is a Claude session running remotely; `integration` has no tool of
  // its own and stays unattributed rather than being guessed onto an agent.
  if (driver === "claude" || driver === "max" || driver === "cloud") return "forge";
  return null;
}

/**
 * THE DRIVER IS GROUND TRUTH. The model is not the platform.
 *
 * This asked the model family FIRST and used the driver only as a fallback, which
 * gets the answer backwards whenever a tool runs a model from another vendor -
 * and several do. Vega can run another vendor's model through Codex;
 * Quill runs Composer through Cursor; Cursor can run Claude models directly.
 *
 * Family is still the fallback, for rows that carry a model but no driver.
 */
function identityForSession(family: ModelFamily | null, driver: Driver): AgentIdentity | null {
  if (family === "hermes") return SESSION_AGENT_IDENTITY["hermes"] ?? null;
  const key = codenameForDriver(driver) ?? codenameForFamily(family);
  return key ? SESSION_AGENT_IDENTITY[key] ?? null : null;
}

/**
 * The canonical idle fleet - shown when no live Claude sessions are running.
 * Names and ids match the locked codenames in graph.ts AGENTS.
 * Status is always "idle" here; real activity comes from useAgentRoster via fd_sessions.
 * Only surfaced in DEV (dev server / browser preview) - the shipped Tauri app
 * replaces this with real session data the moment any session is running, and shows
 * all agents idle (not fake-working) when nothing is.
 */
export const MOCK_AGENTS: AgentRow[] = [
  {
    id: "a.praxis",
    name: "Praxis",
    model: "hermes",
    family: "hermes",
    status: "idle",
    role: "orchestrator",
    task: null,
    thought: null,
    lane: "feat/flight-deck",
    touches: ["Praxis"],
    live: false,
    prog: 0,
    progKnown: false,
    focus: null,
  },
  {
    id: "a.forge",
    name: "Forge",
    model: "claude-opus-4-8",
    family: "opus",
    status: "idle",
    role: "Claude Coder",
    task: null,
    thought: null,
    lane: null,
    touches: ["Praxis", "Catalyzed Alpha"],
    live: false,
    prog: 0,
    progKnown: false,
    focus: null,
  },
  {
    id: "a.vega",
    name: "Vega",
    model: "codex",
    family: "codex",
    status: "idle",
    role: "Codex Coder",
    task: null,
    thought: null,
    lane: null,
    touches: ["Praxis", "Catalyzed Alpha"],
    live: false,
    prog: 0,
    progKnown: false,
    focus: null,
  },
  {
    id: "a.quill",
    name: "Quill",
    model: "cursor",
    family: "cursor",
    status: "idle",
    role: "Cursor Coder",
    task: null,
    thought: null,
    lane: null,
    touches: ["Praxis"],
    live: false,
    prog: 0,
    progKnown: false,
    focus: null,
  },
  {
    id: "a.atlas",
    name: "Atlas",
    model: "codex",
    family: "codex",
    status: "idle",
    role: "Operator",
    task: null,
    thought: null,
    lane: null,
    touches: ["Praxis"],
    live: false,
    prog: 0,
    progKnown: false,
    focus: null,
  },
  {
    id: "a.sage",
    name: "Sage",
    model: "claude-sonnet-4-6",
    family: "sonnet",
    status: "idle",
    role: "Research",
    task: null,
    thought: null,
    lane: null,
    touches: ["Catalyzed Alpha", "Finance"],
    live: false,
    prog: 0,
    progKnown: false,
    focus: null,
  },
  {
    id: "a.lens",
    name: "Lens",
    model: "claude-sonnet-5",
    family: "sonnet",
    status: "idle",
    role: "QA",
    task: null,
    thought: null,
    lane: null,
    touches: ["Praxis"],
    live: false,
    prog: 0,
    progKnown: false,
    focus: null,
  },
  {
    id: "a.ledger",
    name: "Ledger",
    model: "claude-sonnet-4-6",
    family: "sonnet",
    status: "idle",
    role: "Records",
    task: null,
    thought: null,
    lane: null,
    touches: ["Finance"],
    live: false,
    prog: 0,
    progKnown: false,
    focus: null,
  },
  {
    id: "a.relay",
    name: "Relay",
    model: "claude-sonnet-5",
    family: "sonnet",
    status: "idle",
    role: "Router",
    task: null,
    thought: null,
    lane: null,
    touches: ["Praxis"],
    live: false,
    prog: 0,
    progKnown: false,
    focus: null,
  },
  {
    id: "a.hermes",
    name: "Hermes",
    model: "hermes",
    family: "hermes",
    status: "idle",
    role: "Brain Engine",
    task: null,
    thought: null,
    lane: null,
    touches: ["Praxis"],
    live: false,
    prog: 0,
    progKnown: false,
    focus: null,
  },
];

const inTauri = (): boolean =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

function sessionStatus(s: SessionCard): AgentStatus {
  // A Claude Code window left open at an empty prompt is `running` all day and must read IDLE,
  // not working, or agents orbit the brain with nothing happening.
  //
  // `working` is authoritative when the backend supplies it. The ageMs fallback
  // is only for a snapshot from an older backend that has no `working` field.
  if (s.working !== undefined) return s.working ? "working" : s.running ? "idle" : s.status === "recent" ? "idle" : "done";
  if (s.running) return s.ageMs >= 30 * 60 * 1000 ? "idle" : "working";
  return s.status === "recent" ? "idle" : "done";
}

/** Flatten the live Flight Deck snapshot into agent rows (most-active first).
 *
 * Groups every session by resolved agent identity FIRST, then derives each merged
 * row's display fields in one pass at the end - never incrementally, so the "N lanes"
 * summary is computed exactly once from the group's true session count and the raw
 * (never-before-prefixed) primary session's title. An earlier version prefixed
 * `"{count} lanes · "` onto whatever the accumulator's `task` already was on every
 * additional session merged in, so an agent running N lanes accumulated a cascading
 * `"N lanes · N-1 lanes · ... · 1 run · 7d ago"` string instead of one clean summary
 * (2026-07-10 CDP QA, CC-FORGE). */
export function rowsFromSnapshot(snap: LanesSnapshot): AgentRow[] {
  const sessionsById = new Map<string, AgentRow[]>();
  for (const repo of snap.repos ?? []) {
    for (const lane of repo.lanes ?? []) {
      for (const s of lane.sessions ?? []) {
        if (s.status === "dormant" && !s.running) continue; // keep the fleet to what's alive-ish
        const fam = modelFamily(s.model);
        const identity = identityForSession(fam, lane.driver);
        if (!identity) continue;
        const row: AgentRow = {
          id: identity.id,
          name: identity.name,
          model: s.model,
          family: fam,
          status: sessionStatus(s),
          role: identity.role,
          task: s.title,
          thought: s.preview,
          lane: lane.branch || lane.label,
          touches: [repo.label],
          live: true,
          // The coarse fd_sessions snapshot has NO per-task percentage. This is a
          // shape hint for the rig's hairline only; progKnown=false stops every
          // surface from printing it as a measured percentage.
          prog: s.running ? (s.role === "build" ? 0.5 : 0.25) : s.status === "recent" ? 1 : 0,
          progKnown: false,
          // Best-effort current focus: the session's own title (the galaxy resolves it
          // to a node when it names one; otherwise the rig sits on the agent's area).
          focus: s.title ?? null,
        };
        const group = sessionsById.get(row.id);
        if (group) group.push(row);
        else sessionsById.set(row.id, [row]);
      }
    }
  }

  const merged: AgentRow[] = [];
  for (const rows of sessionsById.values()) {
    let primary = rows[0];
    for (const r of rows.slice(1)) if (compareAgentRows(r, primary) < 0) primary = r;

    const touches = new Set<string>();
    let prog = 0;
    let focus: string | null = null;
    let thought: string | null = null;
    for (const r of rows) {
      r.touches.forEach((t) => touches.add(t));
      prog = Math.max(prog, r.prog);
      if (!focus && r.focus) focus = r.focus;
      if (!thought && r.thought) thought = r.thought;
    }

    const rawTask = primary.task; // never itself a "N lanes · " prefix - see rows[]
    merged.push({
      ...primary,
      task: rows.length > 1 && rawTask ? `${rows.length} lanes · ${rawTask}` : rawTask,
      thought: primary.thought ?? thought,
      touches: [...touches],
      prog,
      focus: primary.focus ?? focus,
    });
  }
  return merged.sort(compareAgentRows);
}

function compareAgentRows(a: AgentRow, b: AgentRow): number {
  // Order by work-state first, then by real task progress (build sessions rank above
  // passive ones), then name for a stable tiebreak. No fabricated "load" here - the
  // old token-estimate sort key was removed (2026-07-10) along with estTokens.
  const order: Record<AgentStatus, number> = { working: 0, idle: 1, done: 2 };
  return order[a.status] - order[b.status] || b.prog - a.prog || a.name.localeCompare(b.name);
}

/**
 * The canonical idle fleet for the Tauri app (all agents docked, no fake tasks).
 * This is what shows when Tauri is running but no sessions are active - accurate,
 * not a demo. The MOCK_AGENTS fleet (fake working states) is only used in the
 * browser dev server where fd_sessions is unavailable.
 */
const IDLE_FLEET: AgentRow[] = MOCK_AGENTS.map((a) => ({
  ...a,
  status: "idle" as const,
  task: null,
  thought: null,
}));

/** True only in the browser dev server (Vite), not in the Tauri shell. */
const inBrowserDev = (): boolean =>
  typeof window !== "undefined" &&
  !("__TAURI_INTERNALS__" in window) &&
  !("__TAURI__" in window);

/**
 * The roster hook. In the Tauri shell:
 *   • polls fd_sessions every 2.5s and shows live session rows when running
 *   • shows the canonical idle fleet (all agents docked) when no sessions are running
 *   • never falls back to fake "working" states - idle = truly idle
 * In the browser dev server only: seeds MOCK_AGENTS so the window is never blank.
 */
// ── ONE roster loop per window (memory/architecture fix, 2026-07-10) ─────────
// The old hook started its OWN 2.5s fd_sessions poll + listener PER INSTANCE.
// After the one-truth work put useFiringAgents into StateBar + Hud + RightDock,
// the main renderer was parsing 3 full LanesSnapshots every 2.5s forever - the
// IPC/alloc churn that saturated the renderer toward its OOM crash page. Now a
// module-level singleton polls ONCE per window (5s + instant push refresh) and
// every hook instance subscribes to the same state via useSyncExternalStore.
interface RosterState {
  agents: AgentRow[];
  live: boolean;
}
let rosterState: RosterState = { agents: inBrowserDev() ? MOCK_AGENTS : IDLE_FLEET, live: false };
const rosterSubs = new Set<() => void>();
let rosterStarted = false;
let rosterEverLive = false;
let rosterEmptyStreak = 0;
const ROSTER_EMPTY_FALLBACK = 2; // ~10s of empty 5s-polls before the idle fleet

let snapshotRoster = rosterState;
const missionRoster = new Map<string, AgentRow>();
const missionLabels = new Map<string, string>();
function setRoster(next: RosterState) {
  snapshotRoster = next;
  const agents = next.agents.slice();
  for (const row of missionRoster.values()) {
    const at = agents.findIndex((a) => a.id === row.id);
    if (at >= 0) agents[at] = row;
    else agents.push(row);
  }
  rosterState = { agents, live: next.live || missionRoster.size > 0 };
  rosterSubs.forEach((cb) => cb());
}

// Mission dispatch is direct execution evidence. It outranks the slower census
// until that step stops; unrelated session and synthetic events never override it.
eventBus.subscribe((e) => {
  if (!e.orchestrator || e.synthetic) return;
  if (e.missionNode) missionLabels.set(e.missionNode.id, e.missionNode.label);
  if (!e.agentId || !e.taskId) return;
  const seed = IDLE_FLEET.find((a) => a.id === e.agentId);
  if (!seed) return;
  if (e.type === "agent:status") {
    if (e.status === "working") {
      missionRoster.set(e.agentId, { ...seed, status: "working", live: true,
        model: e.model ?? seed.model, family: e.model ? modelFamily(e.model) : seed.family,
        task: missionLabels.get(e.taskId) ?? e.label ?? e.taskId, focus: e.taskId,
        touches: e.areaId ? [e.areaId] : [],
      });
    } else {
      const active = missionRoster.get(e.agentId);
      if (active?.focus === e.taskId) missionRoster.delete(e.agentId);
    }
  } else if (e.type === "agent:thinking") {
    const active = missionRoster.get(e.agentId);
    if (active) missionRoster.set(e.agentId, { ...active, thought: e.thought ?? null });
  }
  setRoster(snapshotRoster);
});

async function rosterPull(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const snap = await invoke<LanesSnapshot>("fd_sessions");
    const rows = rowsFromSnapshot(snap);
    if (rows.length) {
      rosterEmptyStreak = 0;
      rosterEverLive = true;
      setRoster({ agents: rows, live: true });
    } else {
      rosterEmptyStreak += 1;
      // after a sustained empty streak, show the accurate idle fleet (not fake
      // working states) - the panel stays populated but truthful.
      if (!rosterEverLive || rosterEmptyStreak >= ROSTER_EMPTY_FALLBACK) {
        setRoster({ agents: IDLE_FLEET, live: false });
      }
    }
  } catch {
    /* not available / dev server down → keep the current fleet */
  }
}

function startRosterLoop(): void {
  if (rosterStarted || !inTauri()) return;
  rosterStarted = true;
  void rosterPull();
  // Window-lifetime loop (never torn down - the window's own lifecycle owns it).
  // Pauses while hidden + one catch-up on visible; push events refresh instantly,
  // so 5s polling loses no responsiveness vs the old 2.5s-per-instance storm.
  visibleInterval(() => void rosterPull(), 5000);
  import("@tauri-apps/api/event")
    .then(({ listen }) => listen("praxis://session-state", () => void rosterPull()))
    .catch(() => {});
}

export function useAgentRoster(): { agents: AgentRow[]; live: boolean } {
  return useSyncExternalStore(
    (cb) => {
      rosterSubs.add(cb);
      startRosterLoop();
      return () => {
        rosterSubs.delete(cb);
      };
    },
    () => rosterState,
    () => rosterState,
  );
}

/**
 * THE one literal "firing agents" list every brain-window surface reads - the
 * StateBar's "N FIRING", the BrandBlock's firing count, and the Inspector's
 * "Firing now" list. It is sourced from the SAME fd_sessions snapshot the Memory
 * Galaxy, Command Center, and Flight Deck already read (useAgentRoster), so the
 * literal count can never diverge across windows again (visual-truth one-truth
 * rule, 2026-07-10 CDP QA: brain said "5 FIRING" while galaxy/deck read 0-1 off
 * fd_sessions - because the brain counted the EVENT BUS instead). The event bus now
 * drives ONLY ambience (the 3D glow/thinking pulse + the thought ticker), never the
 * number.
 *
 * Filters to genuinely-working sessions and drops the invisible infra engine rows
 * (Hermes/Relay/Ledger) - the same exclusion the store's isFiringAgent applies. It's
 * kept as a LOCAL id set on purpose: a live fd_sessions row only ever resolves to
 * forge/vega/quill/hermes (see SESSION_AGENT_IDENTITY), and keeping the rule here
 * means this module never has to import the brain store into the Galaxy/Command
 * Center bundles that also consume useAgentRoster.
 *
 * The 30-min parked rule lives in sessionStatus(): a still-running-but-silent
 * session (≥30 min without transcript activity) reads as "idle" here, not "working",
 * so a 9-hour process counts as parked, never as firing.
 */
const NON_FIRING_ROSTER_IDS: ReadonlySet<string> = new Set(["a.hermes", "a.relay", "a.ledger"]);
export function useFiringAgents(): AgentRow[] {
  const { agents } = useAgentRoster();
  return agents.filter((a) => a.status === "working" && !NON_FIRING_ROSTER_IDS.has(a.id));
}

export { MODEL_LABEL, MODEL_TINT };
