/**
 * Discrete UI state (Zustand).
 *
 * This store holds only state that changes at *human* rate and is safe to render in
 * React: the current selection / camera focus, theme, nav mode, the agent roster,
 * task status, and recent file-births. The high-frequency per-frame animation state
 * (node glow, travelling pulses, agent positions) deliberately lives in the 3D
 * layer's refs and is driven straight off the eventBus - never through React.
 */

import { create } from "zustand";
import { AGENTS, buildGraph, seedMilestoneStatuses, setMilestoneStatus, sproutTask } from "@/data/graph";
import { AGENT_GLYPH, AREA_GLYPH, type GlyphId } from "@/glyphs/glyphs";
import { eventBus } from "@/data/eventBus";
import { getCenteredNode, getNodeAtScreen, cameraStepOut } from "@/brain/cameraApi";
import {
  AUTHORED_MILESTONES,
  STATUS_RANK,
  type JourneyMilestone,
  type MilestoneStatus,
} from "@/data/journey";
import { journeyLanes, journeyMaxSlot, journeyMinSlot, NOW_SLOT } from "@/data/journeyLayout";
import { parseDump, routeArea } from "@/orchestrator/parse";
import { respond, greeting, type OrchReply } from "@/orchestrator/respond";
import type { PraxisEvent } from "@/data/schema";
import { loadAutonomy, saveAutonomy, type AutonomyKey } from "@/shared/autonomy";
import { setExecMode } from "@/command/controlStore";
import { explicitWebSearchQuery, searchWebAnswer, webSearchSpokenBrief } from "@/voice/webSearchAnswer";

/**
 * Mirror a TYPED Atlas turn into the durable thread.
 *
 * The in-memory `chat` array is a 40-message display buffer, not storage. Voice
 * turns were already persisted by atlasChatBridge; typed ones were not, so after
 * a restart the Atlas panel showed every spoken line and nothing the owner had written.
 * Dynamic import keeps the store free of a load-time dependency on the voice lane
 * and matches how the rest of this file reaches sibling modules.
 */
function persistTyped(role: "zach" | "agent", text: string): void {
  if (!text.trim()) return;
  void import("@/voice/atlasChatBridge")
    .then((m) => m.mirrorTypedTurn(role, text))
    .catch(() => {
      /* dev browser / bridge unavailable - the bubble is still on screen */
    });
}
import {
  DEFAULT_THEME,
  THEMES,
  loadActiveTheme,
  loadCustomPalette,
  saveActiveTheme,
  type ActiveThemeName,
  type Palette,
  type ThemeName,
} from "@/theme/tokens";

export type NavMode = "orbit" | "gesture";
export type ViewMode = "brain" | "journey";
/**
 * What the journey camera is framing - the discriminant CameraRig flies to.
 *   time    = a vertical slice of the roadmap at a time column (←/→ sweep)
 *   area    = one whole initiative lane, auto-fit (number-key jump / rail click)
 *   areaRow = a pure VERTICAL bump to the adjacent lane, keeping the current
 *             time-X and zoom (↑/↓ arrows - glide up/down between rows, never a
 *             sideways jump through time and never a rezoom)
 *   task    = a single milestone, detail card open ([ / ] hop, or a click)
 */
export type JourneyView =
  | { kind: "time"; col: number }
  | { kind: "area"; areaId: string }
  | { kind: "areaRow"; areaId: string }
  | { kind: "task"; id: string };
/**
 *   atlas  = the isometric task-CITY (premium bento dashboard + instanced city)
 * Distinct from `viewMode` (brain↔journey morph), which lives inside `neural`.
 */
export type Direction = "neural" | "atlas";
const DIRECTION_KEY = "praxis-direction";
const loadDirection = (): Direction => {
  try {
    return localStorage.getItem(DIRECTION_KEY) === "atlas" ? "atlas" : "neural";
  } catch {
    return "neural";
  }
};
const saveDirection = (d: Direction) => {
  try {
    localStorage.setItem(DIRECTION_KEY, d);
  } catch {
    /* best-effort */
  }
};
export interface ChatMsg {
  id: number;
  role: "you" | "orch";
  text: string;
  /** Journey node this message points at (renders a fly-to action). */
  refId?: string;
}

export interface AgentLive {
  id: string;
  name: string;
  role: string;
  status: "idle" | "working" | "done";
  taskId?: string;
  areaId?: string;
  thought?: string;
  /** The session's REAL human task title (branch/repo or a genuinely-matched milestone
   *  label) - set from agent:status `label`. The literal-fact surfaces (roster/feed)
   *  prefer this over the taskId node label, which for an unidentified session is only
   *  a repo/area anchor (never the "Live event bridge" mechanism-milestone leak). */
  title?: string;
  /** Claude model driving this agent (persists across idle for the roster pill). */
  model?: string;
  /** seconds (performance.now()/1000) of last activity - sorts the roster AND drives the
   *  single decay window in reconcileFiring. */
  lastActive: number;
}

/**
 * THE one rule for "does this agent count as a live *firing* coding/work agent?"
 * (visual-truth mandate 2026-07-10). Consumed by StateBar, Waveform, the store's own
 * activity derivation, and gatherAskContext - so the FIRING count can never diverge
 * between them. Real coders (Forge/Vega/Quill), QA (Lens), and any real flow-lane worker
 * count. EXCLUDED: the orchestrator CORE (a.praxis) and always-on AMBIENT services
 * (Atlas voice companion, Sage research-watch, Scribe), plus the invisible infra engine
 * (Hermes/Relay/Ledger, `infra:true` in graph.ts) - none of those are a discrete coding
 * session, so counting them as "firing" over-reports what's really being built.
 */
export const AMBIENT_AGENT_IDS: ReadonlySet<string> = new Set([
  "a.praxis",
  "a.atlas",
  "a.sage",
  "a.scribe",
]);
const INFRA_AGENT_IDS: ReadonlySet<string> = new Set(
  AGENTS.filter((a) => a.infra).map((a) => a.id),
);
export function isFiringAgent(id: string): boolean {
  return !AMBIENT_AGENT_IDS.has(id) && !INFRA_AGENT_IDS.has(id);
}
/** The canonical firing set - the ONE derivation every literal-fact consumer reads. */
export function selectFiringAgents(agents: Record<string, AgentLive>): AgentLive[] {
  return Object.values(agents).filter((a) => a.status === "working" && isFiringAgent(a.id));
}
/** Single decay window (seconds): a firing-eligible agent left "working" with neither a
 *  live fd/flow session nor a fresh event past this is stood down (a missed idle event →
 *  self-heals so the brain's count converges with the Flight Deck's running-process
 *  truth). See reconcileFiring. */
export const FIRING_DECAY_S = 60;

export interface TaskLive {
  progress: number;
  active: boolean;
  lastTouch: number;
}

/** One cell of the bottom event-timeline strip (R14). */
export interface FeedItem {
  id: number;
  /** Loop-seconds of the source event (mock clock - display is relative). */
  t: number;
  glyph: GlyphId;
  kind: "work" | "done" | "file" | "memory";
  text: string;
  /** Node the cell flies to when clicked. */
  refId?: string;
  areaId?: string;
}

/** Which tab occupies the right dock (v2: inspector ⇄ inbox ⇄ controls). */
export type RightTab = "inspector" | "inbox" | "controls";

/** Cluster medallion symbol style - the live compare the owner cycles from the
 *  CONTROLS tab: classic glyph · orbital reticle · per-cluster constellation.
 *  ("letter" was tried 2026-07-05 and rejected - never resurrect it.) */
export type ClusterSigil = "glyph" | "orbital" | "constellation";
const SIGIL_KEY = "praxis-cluster-sigil";
const loadSigil = (): ClusterSigil => {
  try {
    const v = localStorage.getItem(SIGIL_KEY);
    return v === "orbital" || v === "constellation" ? v : "glyph"; // "letter" migrates to glyph
  } catch {
    return "glyph";
  }
};
const saveSigil = (v: ClusterSigil) => {
  try {
    localStorage.setItem(SIGIL_KEY, v);
  } catch {
    /* best-effort */
  }
  // durable disk mirror (survives WebView2 data loss)
  void import("@/shared/persist").then(({ mirrorSet }) => mirrorSet(SIGIL_KEY, v)).catch(() => {});
};

export interface FileBirth {
  id: string;
  label: string;
  path?: string;
  taskId?: string;
  areaId?: string;
  at: number;
}

/**
 * One PART of a submitted work-order (spec 2026-07-06 "loop-to-completion").
 * A prompt fans out into parts - filed items, control commands, build goals,
 * answered questions - and the work-order stays alive until every part is done.
 */
export type WorkPartKind = "file" | "command" | "goal" | "answer";
export type WorkPartStatus = "running" | "done" | "failed";
export interface WorkPart {
  id: number;
  kind: WorkPartKind;
  /** Short human label for the part ("filed 2 ideas", "build the tile layout", …). */
  label: string;
  status: WorkPartStatus;
  /** Optional detail surfaced on completion (goal summary, answer snippet, error). */
  detail?: string;
}

/**
 * A submitted prompt held as a PERSISTENT contract. It is NOT cleared when the text is submitted
 */
export interface WorkOrder {
  id: number;
  text: string;
  parts: WorkPart[];
  createdAt: number;
}

interface PraxisState {
  // --- presentation ---
  themeName: ActiveThemeName;
  setTheme: (t: ActiveThemeName) => void;
  /** The Theme-Lab palette (live-editable; persisted via "Save scheme"). */
  customPalette: Palette;
  /** Patch Theme-Lab tokens - switches the active theme to "custom". */
  setCustomPalette: (patch: Partial<Palette>) => void;

  mode: NavMode;
  setMode: (m: NavMode) => void;
  toggleMode: () => void;

  /** Voice mode (Praxis): wake-word listening + spoken replies. Key: V. */
  voiceOn: boolean;
  /** true WHILE the focused mic is actively capturing - drives the brain's listening cue. */
  voiceListening: boolean;
  setVoiceListening: (v: boolean) => void;
  setVoiceOn: (v: boolean) => void;
  toggleVoice: () => void;

  /** Autonomy / trust level - how much Praxis may do on its own. Set from the Command
   *  Center dial (persisted + broadcast); the brain surfaces it as the active leash. */
  autonomy: AutonomyKey;
  setAutonomy: (a: AutonomyKey) => void;

  /** The live visual-direction toggle: neural field ⇄ atlas task-city. */
  direction: Direction;
  setDirection: (d: Direction) => void;
  toggleDirection: () => void;

  /** Right-dock tab (inspector ⇄ inbox ⇄ controls). */
  rightTab: RightTab;
  setRightTab: (t: RightTab) => void;
  /* */
  pulloutDoc: import("@/command/inboxStore").InboxDoc | null;
  setPulloutDoc: (d: import("@/command/inboxStore").InboxDoc | null) => void;
  /** Present a doc on the full-width surface AND narrate it - the single hook for
   *  "Praxis is speaking a summary/walkthrough → the pull-out opens itself." */
  narrateDoc: (d: import("@/command/inboxStore").InboxDoc, leadIn?: string) => void;
  /** Cluster medallion symbol style (the live A/B - persisted). */
  clusterSigil: ClusterSigil;
  setClusterSigil: (v: ClusterSigil) => void;
  showPerf: boolean;
  setShowPerf: (v: boolean) => void;
  paused: boolean;
  setPaused: (v: boolean) => void;
  /** The core's thin instrument-ring bezel (design lock: a toggle the owner judges live). */
  ringFrame: boolean;
  setRingFrame: (v: boolean) => void;

  // --- journey (the time-corridor view of the same canvas) ---
  /** brain = NOW (radial nebula) · journey = STORY (time-corridor). Key: J. */
  viewMode: ViewMode;
  setViewMode: (v: ViewMode) => void;
  toggleViewMode: () => void;
  /** THE canonical plan (spec §B.1): authored roadmap + brain-dump sprouts. */
  journey: JourneyMilestone[];
  /** Bumps when nodes are added to the live graph (labels re-enumerate). */
  graphVersion: number;
  /** 3D sprout slots remaining this session (the runtime keeps this honest). */
  sproutSlotsLeft: number;
  /** The focused milestone (task cursor) - drives the detail panel + label highlight. */
  journeyCursorId: string | null;
  /** Current time-scrub column (null = not scrubbing). ←/→ move this. */
  journeyTimeCol: number | null;
  /** Focused initiative lane (null = whole roadmap). ↑/↓ move this. */
  journeyAreaId: string | null;
  /** What the camera is currently framing in journey mode (drives CameraRig). */
  journeyView: JourneyView | null;
  /** ← / → : sweep the camera through TIME across the whole roadmap (past↔future). */
  scrubTime: (dir: 1 | -1) => void;
  /** ↑ / ↓ : bump VERTICALLY to the adjacent lane, keeping time-X + zoom. */
  switchArea: (dir: 1 | -1) => void;
  /** Frame a specific lane (rail click / number key in journey mode). */
  focusAreaLane: (areaId: string) => void;
  /** [ / ] : hop task-to-task within the focused lane (the detail axis). */
  hopTask: (dir: 1 | -1) => void;
  /** Back-compat: gesture swipe → time scrub (input modes stay co-equal). */
  stepJourney: (dir: 1 | -1) => void;
  /** Fly to a journey milestone and park the cursor on it (panels/dump use this). */
  focusJourney: (id: string) => void;
  /** Gesture drill (five-finger spread/contract): dive into the task you're centered
   *  on - the click-to-open-detail level a plain dolly can't reach - and pop back out
   *  to normal navigation. No-op when there's nothing to drill (e.g. bare overview). */
  /** Gesture drill IN. `pointer` = the hand's screen position in NDC ([-1,1], y up);
   *  when given, dive into the cluster nearest it (point-at-cluster), else the centered one. */
  drillIn: (pointer?: { x: number; y: number }) => void;
  drillOut: () => void;

  // --- orchestrator (mock, zero spend) ---
  dumpOpen: boolean;
  setDumpOpen: (v: boolean) => void;
  chatOpen: boolean;
  setChatOpen: (v: boolean) => void;
  chat: ChatMsg[];
  /** Bumps whenever Atlas starts fresh so delayed answers cannot repopulate it. */
  atlasChatResetNonce: number;
  /** Clear only the visible Atlas buffer; durable transcript rows remain on disk. */
  resetAtlasChat: () => void;
  /** Ask the real brain, falling back to the deterministic journey responder. */
  /**
   * `transcript: "caller"` = the caller records this exchange itself (the voice lanes
   * do, as `voice` turns), so ask() adds no typed bubble and persists nothing. Default
   * "panel" is the typed Atlas box.
   */
  ask: (
    q: string,
    opts?: { speak?: boolean; signal?: AbortSignal; transcript?: "panel" | "caller" },
  ) => Promise<OrchReply | null>;
  /** Brain-dump → parse → sprout onto the corridor. Returns created milestones.
   *  `skip`: clauses the caller ALREADY handed to the orchestrator (the unified
   *  input's submit()) - filed here, never dispatched a second time. */
  receiveMissionNode: (node: JourneyMilestone) => void;
  fileMissionNode: (title: string, areaHint?: string) => { taskId: string; areaId: string };
  dump: (text: string, opts?: { skip?: string[] }) => JourneyMilestone[];

  // --- unified input (the work-order) ---
  /**
   * THE primary-input action (spec 2026-07-06). Classifies the prompt and fans
   * out to file (dump) + execute (command/orchestrate) + answer (ask) - doing
   * every faculty that applies. Registers a persistent WorkOrder so the prompt
   * survives until all its parts complete. Returns the work-order id.
   */
  submit: (text: string) => Promise<number | null>;
  /** The live work-order for the last submitted prompt (null once cleared). */
  workOrder: WorkOrder | null;
  /** Discard the current work-order (the owner's manual clear once he's satisfied). */
  clearWorkOrder: () => void;

  // --- selection / camera focus ---
  /** Node whose detail panel is shown. */
  selectedId: string | null;
  /** Node the camera should fly to (null = overview). */
  focusId: string | null;
  /** Bumped on every focus() so the camera reacts to repeat selects. */
  focusNonce: number;
  hoverId: string | null;
  focus: (id: string | null) => void;
  /** Clear the detail card WITHOUT flying the camera (dock tab switches). */
  deselect: () => void;
  setHover: (id: string | null) => void;

  // --- live reduced state ---
  agents: Record<string, AgentLive>;
  tasks: Record<string, TaskLive>;
  recentFiles: FileBirth[];
  ticker: { name: string; role: string; thought: string } | null;
  /** Rolling event log for the bottom timeline strip (newest first). */
  feed: FeedItem[];

  applyEvent: (e: PraxisEvent) => void;
  /** Surface a transient notice in the bottom timeline strip (errors, hints). */
  notify: (text: string) => void;
  /**
   * Reconcile the firing roster against the live fd/flow snapshot (ONE truth, the Flight
   * Deck definition = running processes). `liveAgentIds` are the agents backed by a
   * running session or flow lane RIGHT NOW. Refreshes their liveness; and reaps any
   * firing-eligible agent still "working" with neither a live session nor a recent event
   * past FIRING_DECAY_S - a missed idle event self-heals, so the brain's count converges
   * with the Flight Deck instead of drifting up. Ambient/infra agents keep their own
   * lifecycles (untouched here). Called each poll tick by useRealEvents.
   */
  reconcileFiring: (
    liveAgentIds: string[],
    now: number,
    liveAnchors?: Map<string, Array<{ areaId: string; taskId?: string; title?: string }>>,
  ) => void;
}

// chat keys must stay unique forever, even after the list trims to 40
let msgSeq = 0;
const nextMsgId = () => ++msgSeq;

// feed keys likewise - the strip trims to 20 but keys never repeat
let feedSeq = 0;
const pushFeed = (feed: FeedItem[], item: Omit<FeedItem, "id">): FeedItem[] =>
  [{ id: ++feedSeq, ...item }, ...feed].slice(0, 20);

// work-order + part ids - monotonic, never reused
let workOrderSeq = 0;
const nextWorkOrderId = () => ++workOrderSeq;

/** Trim a clause to a compact work-order part label. */
const trimLabel = (s: string): string => {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > 46 ? `${t.slice(0, 44).trimEnd()}…` : t;
};

/** A short label for a control-command work-order part, from its parsed intent. */
const commandLabel = (cmd: import("@/voice/commands").VoiceCommand): string => {
  const say = cmd.say?.trim();
  if (say) return trimLabel(say.replace(/[.!]$/, ""));
  // Newer verbs carry no canned line ("refresh-usage") - name them in words, not ids.
  return trimLabel(cmd.intent.kind.replace(/-/g, " "));
};

const nodeLabel = (id: string | undefined): string | undefined =>
  id ? buildGraph().byId.get(id)?.label : undefined;

const milestoneById = (js: JourneyMilestone[], id: string): JourneyMilestone | undefined =>
  js.find((m) => m.id === id);

/**
 * gatherAskContext - the LIVE context every ask() shares.
 *
 * This is the single context pipeline for BOTH conversational surfaces: the fast
 * Atlas panel (OrchestratorPanel) and the deep Mission input (DumpBox → submit()),
 * plus the voice fast-lane (hybridRouter.answerViaAsk), all funnel through ask().
 * Assembling it HERE - once, from the store's own in-memory live state - is what
 * makes Atlas and Praxis answer from the same knowledge: whoever asks, the brain
 * sees the same snapshot of what Praxis is currently doing.
 *
 * Deliberately cheap + synchronous (no Rust round-trip, no new pipeline): a short
 * summary of the agents firing now, the active tasks, and the most recent journey
 * milestones. Passed as brain_chat's `context` arg (injected as "Live context: …").
 * Returns null when there's nothing worth sending so the prompt stays lean.
 */
function gatherAskContext(s: PraxisState): string | null {
  try {
    const lines: string[] = [];

    const firing = selectFiringAgents(s.agents);
    if (firing.length) {
      const who = firing
        .slice(0, 6)
        .map((a) => {
          // prefer the session's REAL title over the taskId node label (which is only a
          // repo/area anchor for an unidentified session - never a mechanism-name guess)
          const task = a.title ?? (a.taskId ? nodeLabel(a.taskId) : undefined);
          return task ? `${a.name} (${task})` : a.name;
        })
        .join(", ");
      lines.push(`Agents firing now: ${who}.`);
    } else {
      lines.push("No agents firing right now.");
    }

    const activeTasks = Object.entries(s.tasks)
      .filter(([, t]) => t.active)
      .map(([id]) => nodeLabel(id))
      .filter((l): l is string => !!l);
    if (activeTasks.length) {
      lines.push(`Active tasks: ${activeTasks.slice(0, 8).join(", ")}.`);
    }

    // The freshest sprouted milestones (what was just filed onto the journey) - the
    // best cheap proxy for "what's top of mind" without a memory-graph round-trip.
    const recent = [...s.journey]
      .filter((m) => m.sprouted)
      .slice(-5)
      .map((m) => m.label);
    if (recent.length) {
      lines.push(`Recently filed: ${recent.join("; ")}.`);
    }

    lines.push(`Trust level: ${s.autonomy}.`);

    const ctx = lines.join(" ").trim();
    return ctx.length > 0 ? ctx.slice(0, 1200) : null;
  } catch {
    return null;
  }
}

/** The lane's "you are here" milestone - active, else nearest upcoming, else first. */
const currentMilestoneOf = (
  js: JourneyMilestone[],
  areaId: string,
): JourneyMilestone | undefined => {
  const lane = js
    .filter((m) => m.areaId === areaId)
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.order - b.order);
  return lane.find((m) => m.status === "active") ?? lane.find((m) => m.status === "next") ?? lane[0];
};

const initialAgents = (): Record<string, AgentLive> =>
  Object.fromEntries(
    AGENTS.map((a) => [
      a.id,
      { id: a.id, name: a.name, role: a.role, status: "idle" as const, lastActive: 0 },
    ]),
  );

// Restore the Theme-Lab state from the last session (best-effort).
const savedCustom = loadCustomPalette();
const savedActive = loadActiveTheme();
const initialTheme: ActiveThemeName =
  savedActive === "custom" && savedCustom
    ? "custom"
    : savedActive && savedActive in THEMES
      ? (savedActive as ThemeName)
      : DEFAULT_THEME;

// ── Journey status overrides (spec §B.4) ───────────────────────────────────────
// The authored roadmap (AUTHORED_MILESTONES) is the BASE; REAL work (a mapped flow
// lane / live session, via the journey:status event) patches a milestone's status
// on top of it. Those runtime overrides persist to localStorage (+ the durable disk
// mirror) so they survive a reload - the seed statuses stay the base a fresh install
// starts from, and only the deltas real work produced are remembered.
const JOURNEY_STATUS_KEY = "praxis-journey-status.v1";
type StatusOverrides = Record<string, MilestoneStatus>;
const VALID_STATUS = new Set<MilestoneStatus>(["done", "active", "next", "later"]);
const loadStatusOverrides = (): StatusOverrides => {
  try {
    const raw = localStorage.getItem(JOURNEY_STATUS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    const out: StatusOverrides = {};
    for (const [id, st] of Object.entries(parsed)) {
      if (VALID_STATUS.has(st as MilestoneStatus)) out[id] = st as MilestoneStatus;
    }
    return out;
  } catch {
    return {};
  }
};
const saveStatusOverrides = (o: StatusOverrides) => {
  try {
    localStorage.setItem(JOURNEY_STATUS_KEY, JSON.stringify(o));
  } catch {
    /* best-effort */
  }
  // durable disk mirror (survives WebView2 data loss) - same pattern as the sigil
  void import("@/shared/persist").then(({ mirrorSet }) => mirrorSet(JOURNEY_STATUS_KEY, JSON.stringify(o))).catch(() => {});
};
const JOURNEY_SPROUTS_KEY = "praxis-journey-sprouts.v1";
const loadSprouts = (): JourneyMilestone[] => {
  try {
    const raw = localStorage.getItem(JOURNEY_SPROUTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as JourneyMilestone[];
    if (!Array.isArray(parsed)) return [];
    // Keep only well-formed rows - a corrupt entry must not break the corridor.
    return parsed.filter(
      (m) => m && typeof m.id === "string" && typeof m.label === "string" && typeof m.areaId === "string",
    );
  } catch {
    return [];
  }
};
const saveSprouts = (list: JourneyMilestone[]) => {
  try {
    localStorage.setItem(JOURNEY_SPROUTS_KEY, JSON.stringify(list));
  } catch {
    /* best-effort */
  }
  void import("@/shared/persist")
    .then(({ mirrorSet }) => mirrorSet(JOURNEY_SPROUTS_KEY, JSON.stringify(list)))
    .catch(() => {});
};
const _sprouts: JourneyMilestone[] = loadSprouts();

const applyStatusOverrides = (
  base: JourneyMilestone[],
  o: StatusOverrides,
): JourneyMilestone[] => base.map((m) => (o[m.id] && o[m.id] !== m.status ? { ...m, status: o[m.id] } : m));

// The overrides read once at boot. Seed them into the graph (via graph.ts, which owns
// the override map so a later rebuild preserves them) so the brain-view status
// (thinking-breath / colour) and the journey corridor start in agreement with what
// real work last recorded.
// Re-sprout persisted thoughts into the GRAPH on boot. Seeding the journey model
// alone is not enough: buildGraph() derives its nodes from AUTHORED_MILESTONES, so
// a filed thought would exist in the plan with no node on the corridor - the node
// The owner watched sprout would still be gone after a restart.
for (const m of _sprouts) {
  try {
    sproutTask(m);
  } catch {
    /* a malformed persisted row must never block boot */
  }
}

const _statusOverrides: StatusOverrides = loadStatusOverrides();

/** Milestone ids whose status was moved by REAL work (a `journey:status` event
 *  from a matched live session), as opposed to the hand-authored plan value in
 *  AUTHORED_MILESTONES.
 *
 *  The distinction matters because the brain's cluster rings were drawing the
 *  authored plan as if it were measured completion - Catalyzed sat at a permanent
 *  3/6 and Praxis at 6/9, numbers that could not move no matter what happened on
 *  the machine. Anything rendering "progress" as a fact must count only these. */
export function observedMilestoneIds(): ReadonlySet<string> {
  return new Set(Object.keys(_statusOverrides));
}
try {
  seedMilestoneStatuses(_statusOverrides);
} catch {
  /* graph unavailable (shouldn't happen) - the journey model override still applies */
}

/** Agents a mission run is driving (agentId -> last orchestrator 'working' ms). See agent:status. */
const missionHold = new Map<string, number>();
const MISSION_HOLD_MS = 45 * 60_000;

export const usePraxisStore = create<PraxisState>((set, get) => ({
  themeName: initialTheme,
  setTheme: (t) => {
    saveActiveTheme(t);
    set({ themeName: t });
  },
  customPalette: savedCustom ?? { ...THEMES[DEFAULT_THEME], label: "Custom" },
  setCustomPalette: (patch) => {
    saveActiveTheme("custom");
    set((s) => ({ customPalette: { ...s.customPalette, ...patch }, themeName: "custom" }));
  },

  mode: "orbit",
  setMode: (m) => set({ mode: m }),
  toggleMode: () => set((s) => ({ mode: s.mode === "orbit" ? "gesture" : "orbit" })),

  voiceOn: false,
  setVoiceOn: (v) => set({ voiceOn: v }),
  toggleVoice: () => set((s) => ({ voiceOn: !s.voiceOn })),
  voiceListening: false,
  setVoiceListening: (v) => set((s) => (s.voiceListening === v ? s : { voiceListening: v })),

  autonomy: loadAutonomy(),
  setAutonomy: (a) => {
    saveAutonomy(a);
    set({ autonomy: a });
    // TRUST-IV AUTO-HYBRID (single funnel): SOVEREIGN ("full") with no live
    // execution channel is a dead end - it must run in an exec mode that can act.
    // Every trust-set path lands here (the Command Center TrustPanel press-and-hold
    // via praxis://autonomy → setAutonomy, voice "go sovereign", and any future
    // surface), so putting the switch HERE - not only in voice/execute.ts - means
    // arming IV from the CC dial can no longer silently leave the mode disagreeing.
    // Hybrid = background-by-default with flagged tasks live (Live alone would force
    // The owner to watch every action; Background can't take the visible desktop).
    if (a === "full") setExecMode("hybrid");
  },

  direction: loadDirection(),
  setDirection: (d) =>
    set((s) => {
      if (s.direction === d) return {};
      saveDirection(d);
      // switching candidates resets selection/scrub so each opens at its overview
      return {
        direction: d,
        selectedId: null,
        focusId: null,
        focusNonce: s.focusNonce + 1,
        journeyCursorId: null,
        journeyTimeCol: null,
        journeyAreaId: null,
        journeyView: null,
      };
    }),
  toggleDirection: () => get().setDirection(get().direction === "neural" ? "atlas" : "neural"),

  rightTab: "inspector",
  // switching AWAY from the inspector clears the selection (the card belongs to
  // the inspector); switching TO it keeps whatever is selected on screen.
  setRightTab: (t) => set(t === "inspector" ? { rightTab: t } : { rightTab: t, selectedId: null }),
  clusterSigil: loadSigil(),
  setClusterSigil: (v) => {
    saveSigil(v);
    set({ clusterSigil: v });
  },
  pulloutDoc: null,
  setPulloutDoc: (d) => set({ pulloutDoc: d, ...(d ? { rightTab: "inspector" as const } : {}) }),
  narrateDoc: (d, leadIn) => {
    // open the surface first so it's already growing as the voice starts
    set({ pulloutDoc: d, rightTab: "inspector" as const });
    if (leadIn) void import("@/voice/speak").then(({ speak }) => speak(leadIn));
  },
  showPerf: false,
  setShowPerf: (v) => set({ showPerf: v }),
  paused: false,
  setPaused: (v) => set({ paused: v }),
  ringFrame: true,
  setRingFrame: (v) => set({ ringFrame: v }),

  viewMode: "brain",
  setViewMode: (v) =>
    set((s) =>
      s.viewMode === v
        ? {}
        : {
            viewMode: v,
            // leaving a mode resets selection + scrub; the camera flies to the
            // new mode's overview while the morph unfurls (the hero moment)
            selectedId: null,
            focusId: null,
            focusNonce: s.focusNonce + 1,
            journeyCursorId: null,
            journeyTimeCol: null,
            journeyAreaId: null,
            journeyView: null,
          },
    ),
  toggleViewMode: () => get().setViewMode(get().viewMode === "brain" ? "journey" : "brain"),

  // seed = authored roadmap with any persisted real-work status overrides folded in
  // Authored plan + everything the owner has filed since (persisted, so a restart no
  // longer deletes his thoughts).
  journey: applyStatusOverrides([...AUTHORED_MILESTONES, ..._sprouts], _statusOverrides),
  graphVersion: 0,
  sproutSlotsLeft: 16,
  journeyCursorId: null,
  journeyTimeCol: null,
  journeyAreaId: null,
  journeyView: null,

  // ←/→ - TIME. Sweep the camera through the whole roadmap: backward = past,
  // forward = through NOW into the future, one slot further each press. NOW (the
  // core) is slot 0; the past runs negative, the future positive. This is the
  // through-line - NOT a task-to-task hop (which lives on [ / ]).
  scrubTime: (dir) => {
    const s = get();
    if (s.viewMode !== "journey") return;
    const minSlot = journeyMinSlot(s.journey);
    const maxSlot = journeyMaxSlot(s.journey);
    if (minSlot === 0 && maxSlot === 0) return;
    const base = s.journeyTimeCol ?? NOW_SLOT; // first press anchors at NOW (slot 0)
    const col = Math.min(Math.max(base + dir, minSlot), maxSlot);
    if (s.journeyTimeCol != null && col === base) return; // already at the edge of time
    set({
      journeyTimeCol: col,
      journeyAreaId: null,
      journeyCursorId: null,
      selectedId: null,
      focusId: null,
      journeyView: { kind: "time", col },
      focusNonce: s.focusNonce + 1,
    });
  },

  // ↑/↓ - AREA. Bump the camera straight UP/DOWN to the adjacent initiative row,
  // keeping the current time-X position AND the current zoom. This is a pure
  // vertical glide between lanes - it must NOT slide sideways through time and
  // must NOT rezoom. (The old version re-framed the whole lane's bounding box,
  // whose centre-X and fit differ per lane, so every press jumped sideways
  // through past/future and changed zoom - exactly the bug the owner hit.)
  switchArea: (dir) => {
    const s = get();
    if (s.viewMode !== "journey") return;
    const lanes = journeyLanes(s.journey);
    if (!lanes.length) return;
    const cur = s.journeyAreaId ? lanes.indexOf(s.journeyAreaId) : -1;
    let idx: number;
    if (cur < 0) idx = dir > 0 ? 0 : lanes.length - 1;
    else {
      idx = Math.min(Math.max(cur + dir, 0), lanes.length - 1);
      if (idx === cur) return; // already at the top/bottom row
    }
    const areaId = lanes[idx];
    set({
      journeyAreaId: areaId,
      // keep journeyTimeCol + journeyCursorId so ←/→ time and [ / ] task
      // continuity survive a row bump; don't pop a detail card (a card focus
      // would yank the camera to that milestone's time slot).
      selectedId: null,
      focusId: null,
      journeyView: { kind: "areaRow", areaId },
      focusNonce: s.focusNonce + 1,
    });
  },

  focusAreaLane: (areaId) => {
    const s = get();
    if (s.viewMode !== "journey") s.setViewMode("journey");
    const cursor = currentMilestoneOf(s.journey, areaId);
    set({
      journeyAreaId: areaId,
      journeyTimeCol: null,
      journeyCursorId: cursor?.id ?? null,
      selectedId: null, // frame the lane; don't pop a card until you drill a task
      focusId: null,
      journeyView: { kind: "area", areaId },
      focusNonce: get().focusNonce + 1,
    });
  },

  // [ / ] - TASK. Hop milestone-to-milestone WITHIN the focused lane (the detail
  // axis). The "different command" task-stepping that does NOT live on arrows.
  hopTask: (dir) => {
    const s = get();
    if (s.viewMode !== "journey") return;
    let areaId = s.journeyAreaId;
    if (!areaId && s.journeyCursorId)
      areaId = milestoneById(s.journey, s.journeyCursorId)?.areaId ?? null;
    if (!areaId) areaId = journeyLanes(s.journey)[0] ?? null;
    if (!areaId) return;
    const lane = s.journey
      .filter((m) => m.areaId === areaId)
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.order - b.order);
    if (!lane.length) return;
    const cur = s.journeyCursorId ? lane.findIndex((m) => m.id === s.journeyCursorId) : -1;
    let idx: number;
    if (cur < 0) idx = dir > 0 ? 0 : lane.length - 1;
    else {
      idx = Math.min(Math.max(cur + dir, 0), lane.length - 1);
      if (idx === cur) return;
    }
    const m = lane[idx];
    set({
      journeyAreaId: areaId,
      journeyTimeCol: null,
      journeyCursorId: m.id,
      selectedId: m.id, // drilling a task opens its detail card
      focusId: m.id,
      journeyView: { kind: "task", id: m.id },
      focusNonce: s.focusNonce + 1,
    });
  },

  // gesture swipe reuses the time scrub (input modes stay co-equal, spec §A.5)
  stepJourney: (dir) => get().scrubTime(dir),

  /** Fly to a journey milestone AND park the cursor on it (panels/dump use this). */
  focusJourney: (id) => {
    const s = get();
    if (s.viewMode !== "journey") s.setViewMode("journey");
    const areaId =
      milestoneById(s.journey, id)?.areaId ?? buildGraph().byId.get(id)?.areaId ?? null;
    set({
      journeyAreaId: areaId,
      journeyTimeCol: null,
      journeyCursorId: id,
      selectedId: id,
      focusId: id,
      journeyView: { kind: "task", id },
      focusNonce: s.focusNonce + 1,
    });
  },

  drillIn: (pointer) => {
    const s = get();
    // Falls back to the most centered cluster/task, then the parked cursor / hovered node.
    const target =
      (pointer ? getNodeAtScreen(pointer.x, pointer.y) : null) ??
      getCenteredNode() ??
      (s.viewMode === "journey"
        ? s.journeyCursorId ??
          (s.journeyAreaId ? currentMilestoneOf(s.journey, s.journeyAreaId)?.id ?? null : null)
        : s.hoverId ?? s.selectedId);
    if (target) s.focus(target);
  },
  drillOut: () => {
    const s = get();
    // TWO STAGES (the owner's spec):
    //  • drilled INTO a task/cluster (something selected) → exit IN PLACE: clear the card,
    //    free the camera + ease out a little - same space, less zoomed, no longer
    //    constrained - WITHOUT flying away to a new framing.
    //  • not in anything → fly all the way out to the whole overview.
    if (s.selectedId) {
      s.deselect();
      set({ journeyView: null });
      cameraStepOut();
    } else {
      s.focus(null);
    }
  },

  dumpOpen: false,
  // Mission and Atlas share the same lower-left reading surface. Keep the persistent mission
  // state, but never stack both panels over each other.
  setDumpOpen: (v) => set({ dumpOpen: v }),
  chatOpen: false,
  setChatOpen: (v) => set({ chatOpen: v }),
  chat: [{ id: 0, role: "orch", text: greeting(AUTHORED_MILESTONES) }],
  atlasChatResetNonce: 0,
  resetAtlasChat: () => set((s) => ({ chat: [], atlasChatResetNonce: s.atlasChatResetNonce + 1 })),
  ask: async (q, opts) => {
    const text = q.trim();
    if (!text || opts?.signal?.aborted) return null;
    // Clearing Atlas must not be undone by a native brain request that was already
    // in flight. The request still completes for its caller; only this panel's old
    // conversation buffer and persistence are fenced off.
    const chatResetNonce = get().atlasChatResetNonce;
    // ONE RECORD PER EXCHANGE. A spoken question answered through here used to be
    // written twice: ask() added a typed bubble and persisted both halves as `typed`,
    // then the voice router wrote both halves again as `voice` - four lines in the
    // Atlas panel for one question (seen live 2026-09-15). A voice caller owns its
    // transcript, so ask() records nothing for it.
    const recordHere = opts?.transcript !== "caller";
    const persist = (role: "zach" | "agent", line: string) => {
      if (recordHere) persistTyped(role, line);
    };
    const chatIsCurrent = () => get().atlasChatResetNonce === chatResetNonce;
    const appendChat = (message: Omit<ChatMsg, "id">) => {
      if (!recordHere || !chatIsCurrent()) return false;
      set((s) => s.atlasChatResetNonce === chatResetNonce
        ? { chat: [...s.chat, { id: nextMsgId(), ...message }].slice(-40) }
        : {});
      return chatIsCurrent();
    };
    // Board-summary intent works from TYPED chat too, not just voice (audit: typed
    // "board summary" replied as a plain bubble instead of pulling out). Same test
    // the voice parser uses (commands.ts show-board); pull the digest out + narrate.
    if (
      /\b(board)\b[^.]*\b(summary|meeting|report|digest)\b/i.test(text) ||
      /\b(summary|report)\b[^.]*\bboard\b/i.test(text)
    ) {
      if (chatIsCurrent()) {
        persist("zach", text);
        appendChat({ role: "you", text });
      }
      try {
        const raw = localStorage.getItem("praxis.board.v1");
        if (raw) {
          const b = JSON.parse(raw) as { date: string; digestMarkdown: string };
          const { digestToSections } = await import("@/command/inboxStore");
          if (opts?.signal?.aborted) return null;
          const reply = `Here's the board summary from ${b.date} — pulling it up now.`;
          if (!chatIsCurrent()) return { text: reply };
          persist("agent", reply);
          appendChat({ role: "orch", text: reply });
          // one call: open the surface + narrate (when voice is live). Praxis
          // speaking a summary now always brings the pull-out with it.
          get().narrateDoc(
            {
              dot: "#e8509d",
              from: "AGENT BOARD",
              time: b.date,
              title: "Daily board meeting — fleet digest",
              meta: "SYNTHESIZED BY THE BRAIN · STATEMENTS BY EACH AGENT · FILED TO THE VAULT",
              sections: digestToSections(b.digestMarkdown),
              kind: "board",
            },
            (opts?.speak ?? get().voiceOn) ? reply : undefined,
          );
          return { text: reply };
        }
      } catch {
        /* fall through to the normal brain reply if the cache is unreadable */
      }
    }
    // show the user's line immediately
    if (opts?.signal?.aborted) return null;
    if (chatIsCurrent()) {
      persist("zach", text);
      appendChat({ role: "you", text });
    }
    // "Search the web" is a first-class Atlas answer, not a browser-opening side
    // effect. Rust returns cited Markdown plus a concise spoken brief; both typed
    // and voice entry points therefore land on the same durable transcript shape.
    const webQuery = explicitWebSearchQuery(text);
    if (webQuery && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) {
      let answerText: string;
      let spokenText: string;
      try {
        const answer = await searchWebAnswer(webQuery, opts?.signal);
        answerText = answer.markdown;
        spokenText = webSearchSpokenBrief(answer);
      } catch (error) {
        if (opts?.signal?.aborted) return null;
        const detail = error instanceof Error ? error.message : String(error);
        answerText = detail || "I couldn't search the web right now.";
        spokenText = answerText;
      }
      if (chatIsCurrent()) {
        persist("agent", answerText);
        appendChat({ role: "orch", text: answerText });
      }
      if (opts?.speak ?? get().voiceOn) {
        const { speak } = await import("@/voice/speak");
        if (opts?.signal?.aborted) return null;
        speak(spokenText);
      }
      return { text: answerText };
    }
    // Browser/dev has no native brain bridge. Keep the planner useful and
    // truthful there by answering from the same live Journey model; native
    // builds continue through the selected real brain below.
    if (!("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) {
      if (opts?.signal?.aborted) return null;
      const localReply = respond(get().journey, text);
      if (chatIsCurrent()) {
        persist("agent", localReply.text);
        appendChat({ role: "orch", text: localReply.text, refId: localReply.refId });
      }
      if (opts?.speak ?? get().voiceOn) {
        const { speak } = await import("@/voice/speak");
        if (opts?.signal?.aborted) return null;
        speak(localReply.text);
      }
      return localReply;
    }
    // REAL brain - brain_chat via the selected provider+model.
    // Retry once on failure; if still down, reply honestly rather than falling
    // back to the Phase-1 journey mock (which is for offline status queries only).
    let replyText: string;
    let refId: string | undefined;
    // SHARED live context - the same snapshot both Atlas and Praxis answer from
    // (see gatherAskContext). Assembled once per ask(); passed to brain_chat's
    // `context` arg. Whoever routed here (Atlas panel, Mission input, or the voice
    // fast-lane) gets Praxis's current state, so they never answer from stale air.
    const liveContext = gatherAskContext(get());
    const callBrain = async (): Promise<string> => {
      const { invoke } = await import("@tauri-apps/api/core");
      if (opts?.signal?.aborted) throw new DOMException("Stopped", "AbortError");
      const { selectedBrain } = await import("@/orchestrator/brain");
      if (opts?.signal?.aborted) throw new DOMException("Stopped", "AbortError");
      const { provider, model, fallbacks } = selectedBrain();
      const reply = (await invoke<string>("brain_chat", { message: text, context: liveContext, model, provider, fallbacks })).trim();
      if (opts?.signal?.aborted) throw new DOMException("Stopped", "AbortError");
      if (!reply) throw new Error("empty");
      return reply;
    };
    try {
      replyText = await callBrain();
    } catch {
      if (opts?.signal?.aborted) return null;
      // one retry - transient network glitch or cold-start
      try {
        replyText = await callBrain();
      } catch (e) {
        if (opts?.signal?.aborted) return null;
        // brain is genuinely unreachable; give an honest answer, never the mock -
        // but surface the REAL cause (timeout / HTTP status / provider body snippet)
        // instead of a generic "unreachable" that hides what actually went wrong.
        const detail = e instanceof Error ? e.message : String(e);
        console.warn("[ask] brain call failed:", detail);
        const { brainFailureReply } = await import("@/orchestrator/brain");
        if (opts?.signal?.aborted) return null;
        replyText = brainFailureReply(detail);
      }
    }
    if (chatIsCurrent()) {
      persist("agent", replyText);
      appendChat({ role: "orch", text: replyText, refId });
    }
    // talk back aloud when voice is on (or when the caller forces it, e.g. the mic path).
    // The brain's speaking pulse is emitted from speak() on ACTUAL audio start, so it stays
    // in phase with the voice - no pre-estimate ripple here.
    if (opts?.speak ?? get().voiceOn) {
      const { speak } = await import("@/voice/speak");
      if (opts?.signal?.aborted) return null;
      speak(replyText);
    }
    return { text: replyText, refId };
  },
  receiveMissionNode: (node) => {
    if (get().journey.some((m) => m.id === node.id)) return;
    sproutTask(node);
    _sprouts.push(node);
    saveSprouts(_sprouts);
    set((s) => ({ journey: [...s.journey, node], graphVersion: s.graphVersion + 1 }));
  },
  fileMissionNode: (title, areaHint) => {
    const s = get();
    const normalized = title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const match = s.journey.find((m) => {
      const label = m.label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      return normalized === label || (label.length >= 8 && normalized.includes(label));
    });
    if (match) {
      eventBus.emitOrchestrator({ type: "journey:sprout", t: 0, nodeId: match.id, areaId: match.areaId, label: match.label, missionNode: match });
      return { taskId: match.id, areaId: match.areaId };
    }
    const areaId = areaHint ?? (/website|personal site/i.test(title) ? "ventures" : routeArea(title));
    const branch = s.journey.filter((m) => m.areaId === areaId);
    const m: JourneyMilestone = {
      id: `j.mission.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 7)}`,
      areaId, label: title, status: "active", sprouted: true,
      order: Math.max(0, ...branch.map((n) => n.order)) + 10,
    };
    sproutTask(m);
    _sprouts.push(m);
    saveSprouts(_sprouts);
    set({ journey: [...s.journey, m], graphVersion: s.graphVersion + 1 });
    eventBus.emitOrchestrator({ type: "journey:sprout", t: 0, nodeId: m.id, areaId, label: title, missionNode: m });
    return { taskId: m.id, areaId };
  },
  dump: (text, opts) => {
    const allDrafts = parseDump(text);
    if (!allDrafts.length) return [];
    const s = get();

    // the runtime preallocates sprout slots - never file what can't be shown
    const slots = s.sproutSlotsLeft;
    if (slots <= 0) {
      set((st) => ({
        chat: [
          ...st.chat,
          {
            id: nextMsgId(),
            role: "orch" as const,
            text: "The map's sprout budget for this session is spent — restart to file more. What you have already filed is saved and comes back with it.",
          },
        ].slice(-40),
      }));
      return [];
    }
    const drafts = allDrafts.slice(0, slots);
    const dropped = allDrafts.length - drafts.length;

    const journey = [...s.journey];
    const created: JourneyMilestone[] = [];
    const events: PraxisEvent[] = [];
    let counter = journey.filter((m) => m.sprouted).length;

    for (const d of drafts) {
      counter += 1;
      const branch = journey.filter((m) => m.areaId === d.areaId);
      const order = Math.max(0, ...branch.map((m) => m.order)) + 10;
      const m: JourneyMilestone = {
        id: `j.${d.areaId}.${counter}`,
        areaId: d.areaId,
        label: d.label,
        status: d.status,
        order,
        eta: d.eta,
        sprouted: true,
      };
      // its neighbors on the branch story line (for story-link wiring)
      const sorted = [...branch, m].sort(
        (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.order - b.order,
      );
      const at = sorted.findIndex((x) => x.id === m.id);
      const prev = at > 0 ? sorted[at - 1] : undefined;
      const next = at < sorted.length - 1 ? sorted[at + 1] : undefined;

      sproutTask(m); // graph first, so the runtime can resolve the node
      journey.push(m);
      created.push(m);
      events.push({
        type: "journey:sprout",
        t: 0,
        nodeId: m.id,
        areaId: m.areaId,
        taskId: prev?.id,
        nextId: next?.id,
        label: m.label,
      });
    }

    // Persist what was just filed BEFORE announcing it, so the green check the
    // panel shows is backed by a write that already happened.
    _sprouts.push(...created);
    saveSprouts(_sprouts);

    set((st) => ({
      journey,
      graphVersion: st.graphVersion + 1,
      chat: [
        ...st.chat,
        {
          id: nextMsgId(),
          role: "orch" as const,
          // NOTE: the sprout-budget notice above is deliberately NOT persisted -
          // it describes this session's remaining allowance, which is meaningless
          // when the thread is reopened. This one IS a real answer about real work.
          text:
            (created.length === 1
              ? `Filed “${created[0].label}” → ${created[0].areaId} · ${created[0].status}${created[0].eta ? ` · ${created[0].eta}` : ""}.`
              : `Filed ${created.length} ideas onto the journey.`) +
            (dropped > 0 ? ` (${dropped} more didn't fit this session's sprout budget.)` : ""),
          refId: created[created.length - 1].id,
        },
      ].slice(-40),
    }));
    // emit AFTER the state lands so the runtime lays the sprout out against
    // the updated journey model (targets are re-read from the store)
    for (const e of events) eventBus.emit(e);
    // the orchestrator speaks its confirmation as it files
    eventBus.emit({ type: "orchestrator:speaking", t: 0, duration: 1.8 });

    // `dispatchBrainDump` splits the dump into asks, routes each to a rail that is
    // actually usable right now (or queues it with the sentence naming the fix),
    // and runs each through the EXISTING orchestrate() loop - which is where the
    // trust dial and the breakers already govern it. That matters: these runs
    // outlive the moment the owner typed the dump, so they are unattended work, and the
    // dial decides how far they may go. The map filing above still happens, so an
    // idea lands on the Journey whether or not anything can run it yet.
    //
    // Dynamic import: the orchestrator reads this store, so a static import would
    // be a cycle. Fire-and-report - the dock must not wait on agent runs.
    //
    // A goal may carry merged continuation clauses ("Create a personal website - you choose the
    // content"), so a filed clause matches its goal by prefix.
    const skip = opts?.skip ?? [];
    const toDispatch = skip.length
      ? text
          .split("\n")
          .map((c) => c.trim())
          .filter((c) => c && !skip.some((g) => g === c || g.startsWith(`${c} — `)))
          .join("\n")
      : text;
    if (!toDispatch.trim()) return created;
    void import("@/orchestrator/orchestrator")
      .then(({ dispatchBrainDump }) => dispatchBrainDump(toDispatch))
      .then((report) => {
        if (!report.summary) return;
        persistTyped("agent", report.summary);
        set((st) => ({
          chat: [...st.chat, { id: nextMsgId(), role: "orch" as const, text: report.summary }].slice(-40),
        }));
      })
      .catch((error: unknown) => {
        // Never silent: a dump that quietly produced nothing is the failure the
        // whole path exists to prevent.
        const detail = error instanceof Error ? error.message : String(error);
        const line = `I filed that, but couldn't dispatch it: ${detail}`;
        persistTyped("agent", line);
        set((st) => ({
          chat: [...st.chat, { id: nextMsgId(), role: "orch" as const, text: line }].slice(-40),
        }));
      });

    return created;
  },

  workOrder: null,
  clearWorkOrder: () => set({ workOrder: null }),
  submit: async (text) => {
    const raw = text.trim();
    if (!raw) return null;

    const { newMissionId, missionTitle, postMissionMsg, praxisSay } = await import("@/orchestrator/missionThread");
    const missionId = newMissionId();
    await postMissionMsg({ missionId, from: "zach", kind: "mission", title: missionTitle(raw), text: raw });
    const { classifySubmit } = await import("@/orchestrator/submitClassify");
    const { areaRefs } = await import("@/voice/execute");
    const plan = classifySubmit(raw, areaRefs());

    // Nothing classifiable at all → treat the whole prompt as a question so the
    // input is never a dead end (the brain answers or files as it sees fit).
    if (
      plan.commands.length === 0 &&
      plan.goals.length === 0 &&
      plan.sovereignGoals.length === 0 &&
      plan.operations.length === 0 &&
      plan.questions.length === 0 &&
      !plan.fileText
    ) {
      plan.questions.push(raw);
    }

    // ── Register the persistent work-order (one part per faculty that fired) ──
    const orderId = nextWorkOrderId();
    const parts: WorkPart[] = [];
    let partSeq = 0;
    const addPart = (kind: WorkPartKind, label: string): number => {
      const id = ++partSeq;
      parts.push({ id, kind, label, status: "running" });
      return id;
    };

    const filePartId = plan.fileText ? addPart("file", "filing onto the journey…") : null;
    const commandPartIds = plan.commands.map((c) =>
      addPart("command", commandLabel(c)),
    );
    const goalPartIds = plan.goals.map((g) =>
      addPart("goal", `${plan.unattended ? "run · " : "build · "}${trimLabel(g)}`),
    );
    // Sovereign lane - a sensitive credentialed/irreversible action. Redact the
    // label so a literal secret pasted into the goal can't ride into the work-order.
    const sovereignPartIds = await (async () => {
      if (!plan.sovereignGoals.length) return [] as number[];
      const { redactGoal } = await import("@/shared/sovereignGate");
      return plan.sovereignGoals.map((g) => addPart("goal", `sovereign · ${trimLabel(redactGoal(g))}`));
    })();
    const operatePartIds = plan.operations.map((o) => addPart("command", `do · ${trimLabel(o)}`));
    const questionPartIds = plan.questions.map((q) => addPart("answer", `answer · ${trimLabel(q)}`));

    set({
      workOrder: { id: orderId, text: raw, parts, createdAt: Date.now() },
    });

    // helper: patch one part of the CURRENT work-order (guarded - the owner may clear it)
    const patchPart = (partId: number, patch: Partial<WorkPart>) =>
      set((st) => {
        if (!st.workOrder || st.workOrder.id !== orderId) return {};
        return {
          workOrder: {
            ...st.workOrder,
            parts: st.workOrder.parts.map((p) => (p.id === partId ? { ...p, ...patch } : p)),
          },
        };
      });

    // Every typed message closes its mission with a word the owner can read. Commands and filing used
    // to report only in the checklist's hover text, and their mission sat in the strip as
    // RUNNING · "planning the work" forever (live 2026-10-10, "reload usage"). Goals, desktop
    // tasks and questions post their own closing message.
    const closesHere = plan.goals.length === 0 && plan.operations.length === 0 && plan.questions.length === 0 && plan.sovereignGoals.length === 0;
    const replies: string[] = [];

    // ── (a) FILE - sprout onto the journey + memory (synchronous, deterministic) ──
    if (filePartId != null && plan.fileText) {
      // The goals in this text are handed to orchestrate() below - file them, but
      // never let the dump dispatch them a second time.
      const made = get().dump(plan.fileText, { skip: plan.goals });
      if (made.length) {
        patchPart(filePartId, {
          status: "done",
          label: made.length === 1 ? `filed “${made[0].label}”` : `filed ${made.length} ideas`,
        });
        get().focusJourney(made[made.length - 1].id);
        replies.push(made.length === 1 ? `Filed “${made[0].label}” onto your journey.` : `Filed ${made.length} ideas onto your journey: ${made.map((m) => `“${m.label}”`).join(", ")}.`);
      } else {
        patchPart(filePartId, { status: "failed", label: "couldn't file that", detail: "sprout budget spent or no plannable content" });
        replies.push("I couldn't file that — nothing in it read as a plan I could put on the journey.");
      }
    }

    // ── (b) EXECUTE control commands - run NOW via the same router the mic uses ──
    // In the background, like everything else that takes time: the Mission box frees up
    // as soon as the message is registered. It used to stay locked until every command
    // and answer finished, so a slow "refresh the flight deck" or a minute-long answer
    // swallowed whatever the owner typed next (live 2026-10-10).
    void (async () => {
    await Promise.all(
      plan.commands.map(async (cmd, i) => {
        const partId = commandPartIds[i];
        try {
          const { executeAndSpeak } = await import("@/voice/execute");
          // Typed into Mission: Praxis acts without talking (owner request 2026-10-10 - read-back is
          // Atlas's job, and only when Atlas was the one asked).
          const res = await executeAndSpeak(cmd, undefined, undefined, { speak: false });
          patchPart(partId, { status: "done", detail: res.reply || undefined });
          replies.push(res.reply?.trim() || "Done.");
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          patchPart(partId, { status: "failed", detail: why });
          replies.push(`That didn't work: ${why}`);
        }
      }),
    );
    if (replies.length) {
      await praxisSay(missionId, "answer", replies.join("\n"), closesHere ? { status: "done" } : {});
    }
    })();

    if (plan.operations.length) {
      void (async () => {
        const { operateTyped } = await import("@/orchestrator/operator");
        for (let i = 0; i < plan.operations.length; i++) {
          const partId = operatePartIds[i];
          const result = await operateTyped(plan.operations[i], { missionId, closes: plan.goals.length === 0 && i === plan.operations.length - 1 });
          patchPart(partId, { status: result.done ? "done" : "failed", detail: result.summary.slice(0, 140) });
          if (!result.done && result.stopped) break;
        }
      })();
    }

    // ── (b) EXECUTE build/do goals - the real orchestrator loop, held to done ──
    // These run in the BACKGROUND (fire-and-track): a build can take minutes and
    // must not block the file/answer parts or freeze the input. The work-order
    // stays alive, showing each goal running until orchestrate() confirms done.
    // One goal stays in the owner's mission. Several goals each become their own mission (own
    // opener, plan and result), and the umbrella says how it was split - closed, so it
    // never reads as a run that is still going.
    const multiGoal = plan.goals.length > 1;
    if (multiGoal) {
      const list = plan.goals.map((g, n) => `${n + 1}. ${missionTitle(g)}`).join("\n");
      void praxisSay(missionId, "note", `That's ${plan.goals.length} separate jobs, so each runs as its own mission:\n${list}`, { status: "done" });
    }
    for (let i = 0; i < plan.goals.length; i++) {
      const goal = plan.goals[i];
      const partId = goalPartIds[i];
      void (async () => {
        try {
          const { orchestrate } = await import("@/orchestrator/orchestrator");
          const result = await orchestrate(goal, { missionId: multiGoal ? `${missionId}-${i + 1}` : missionId, missionOpened: !multiGoal, unattended: plan.unattended });
          patchPart(partId, {
            status: result.done ? "done" : "failed",
            detail: result.summary || (result.done ? "done" : "incomplete — see the fleet"),
          });
        } catch (e) {
          patchPart(partId, { status: "failed", detail: e instanceof Error ? e.message : String(e) });
        }
      })();
    }

    // ── (b) EXECUTE sovereign goals - the credentialed Trust IV loop ──────────
    // A sensitive clause (pay/post/log in/send/buy) routes through the ONE shared
    // gate (sovereignGate.routeSovereign): at Trust IV it opens the sovereign_do
    // browser-automation loop (with per-action human veto fired from Rust); below
    // Trust IV it's refused honestly ("raise the dial") - never silently built.
    // Fire-and-track in the background like build goals: a sovereign run can take
    // minutes (each irreversible step waits on the owner's veto) and must not block the
    // input. The gate does its own notify()/speak() on start/finish/fail; here we
    // just reflect the outcome into the work-order part.
    for (let i = 0; i < plan.sovereignGoals.length; i++) {
      const goal = plan.sovereignGoals[i];
      const partId = sovereignPartIds[i];
      void (async () => {
        try {
          const { routeSovereign } = await import("@/shared/sovereignGate");
          // Mission is a typed surface → speak:false (don't double-talk over ask()).
          const decision = routeSovereign(goal, { speak: false, origin: "live" });
          if (decision.kind === "refused") {
            patchPart(partId, { status: "failed", label: "needs Trust IV — Sovereign", detail: decision.message });
            get().notify(decision.message);
            return;
          }
          if (decision.kind === "sovereign") {
            const outcome = await decision.run;
            patchPart(partId, { status: "done", detail: outcome });
            return;
          }
          // "not-sovereign" can't happen (we pre-classified sensitive) - guard anyway.
          patchPart(partId, { status: "failed", detail: "sovereign routing produced no action" });
        } catch (e) {
          patchPart(partId, { status: "failed", detail: e instanceof Error ? e.message : String(e) });
        }
      })();
    }

    // ── (c) ANSWER questions - real brain reply (parallel, in the background) ──
    void Promise.all(
      plan.questions.map(async (q, i) => {
        const partId = questionPartIds[i];
        try {
          const reply = await get().ask(q, { speak: false });
          await praxisSay(missionId, "answer", reply?.text ?? "No answer was returned. Please try again.", plan.goals.length ? {} : { status: "done" });
          patchPart(partId, {
            status: "done",
            label: `answered · ${trimLabel(q)}`,
            detail: reply?.text?.slice(0, 140),
          });
        } catch (e) {
          patchPart(partId, { status: "failed", detail: e instanceof Error ? e.message : String(e) });
        }
      }),
    );

    return orderId;
  },

  selectedId: null,
  focusId: null,
  focusNonce: 0,
  hoverId: null,
  focus: (id) =>
    set((s) => ({
      selectedId: id,
      focusId: id,
      focusNonce: s.focusNonce + 1,
      // keep the journey camera coherent: a node focus becomes a task view, a
      // clear returns to the roadmap overview (CameraRig ignores this in brain mode)
      journeyView: id ? { kind: "task", id } : null,
      journeyTimeCol: null,
      journeyAreaId: id ? milestoneById(s.journey, id)?.areaId ?? s.journeyAreaId : null,
      // Overview is one atomic state: no hidden task cursor may survive after
      // its area/view are cleared, otherwise the TASK control still names the
      // old milestone and label/camera fallbacks can keep rendering a drill-in.
      journeyCursorId: id ? (s.viewMode === "journey" ? id : s.journeyCursorId) : null,
    })),
  deselect: () => set({ selectedId: null }),
  setHover: (id) => set({ hoverId: id }),

  agents: initialAgents(),
  tasks: {},
  recentFiles: [],
  ticker: null,
  feed: [],

  notify: (text) =>
    set((s) => ({ feed: pushFeed(s.feed, { t: 0, glyph: "praxis", kind: "memory", text }) })),

  reconcileFiring: (liveAgentIds, now, liveAnchors) =>
    set((s) => {
      const live = new Set(liveAgentIds);
      let next: Record<string, AgentLive> | null = null;
      for (const id in s.agents) {
        const a = s.agents[id];
        // Only firing-eligible coding/work agents are reconciled here; ambient/infra
        // agents (atlas/sage/praxis core, hermes engine) keep their own idle lifecycles.
        if (a.status !== "working" || !isFiringAgent(id)) continue;
        // A mission run's hold counts as live. The driver says "working" once at dispatch
        // and then waits minutes on a headless CLI the deck never lists (Praxis-owned
        // sessions are hidden), so this decay used to stand the agent down ~60 s into
        // its step - the orbit the owner asked to watch vanished mid-mission. The hold ends
        // when the run reports done/idle, or after MISSION_HOLD_MS.
        const heldAt = missionHold.get(id);
        const held = heldAt !== undefined && Date.now() - heldAt < MISSION_HOLD_MS;
        if (live.has(id) || held) {
          // Live is per AGENT, not per session: any working Claude session keeps Forge
          // fresh. So an orbit left on an area where none of its sessions is working
          // (a missed event, a stale anchor) used to stay there for as long as Forge
          // worked anywhere else - Forge circling Studio while the real turn was in
          // Praxis. Point it at real work. Area-level only, so this never fights the
          // finer task anchor the push events choose; a mission run's hold still wins.
          const anchors = held ? undefined : liveAnchors?.get(id);
          if (anchors?.length && !anchors.some((x) => x.areaId === a.areaId)) {
            const to = anchors[0];
            next ??= { ...s.agents };
            next[id] = { ...a, areaId: to.areaId, taskId: to.taskId, title: to.title, lastActive: now };
            continue;
          }
          // genuinely live per the fd/flow snapshot → keep fresh so a quiet-but-running
          // lane (a flow lane can be silent for minutes) is never reaped
          if (now - a.lastActive > FIRING_DECAY_S * 0.5) {
            next ??= { ...s.agents };
            next[id] = { ...a, lastActive: now };
          }
        } else if (now - a.lastActive > FIRING_DECAY_S) {
          // no live session AND no recent event → the idle event was missed; stand it
          // down so the count self-heals toward the Flight Deck's running-process truth
          next ??= { ...s.agents };
          next[id] = { ...a, status: "idle", thought: undefined };
        }
      }
      return next ? { agents: next } : {};
    }),

  applyEvent: (e) => {
    // VISUAL-TRUTH GATE (spec §A.2). This reducer owns the DISCRETE, literal-fact UI: the agent
    // roster, task status, the "now firing" ticker, the event-timeline feed, and recent
    // file-births. All of those read as literal claims ("2 agents firing", "Terminal data engine
    // · complete", "Forge is thinking…"), so they must reflect REAL work only. Result: idle →
    // StateBar OBSERVING / 0 FIRING / 0 ACTIVE, empty feed, calm roster; the moment real work
    // lands, every field fills.
    if (e.synthetic) return;
    switch (e.type) {
      case "agent:status": {
        if (!e.agentId) return;
        // A mission run owns the agent it dispatched until the run itself says the step
        // stopped. The slower session census (realEvents) would otherwise move that agent
        // to a repo anchor or idle it mid-step - live 2026-10-01, Forge's mission dispatch
        // was re-anchored to the Praxis node within seconds. Safety expiry: 45 min.
        {
          const now = Date.now();
          if (e.orchestrator) {
            if (e.status === "working") missionHold.set(e.agentId, now);
            else missionHold.delete(e.agentId);
          } else {
            const heldAt = missionHold.get(e.agentId);
            if (heldAt !== undefined && now - heldAt < MISSION_HOLD_MS) return;
            if (heldAt !== undefined) missionHold.delete(e.agentId);
          }
        }
        set((s) => {
          const prev = s.agents[e.agentId!];
          if (!prev) return {};
          const next: AgentLive = {
            ...prev,
            status: e.status ?? prev.status,
            lastActive: e.t,
          };
          if (e.status === "working") {
            next.taskId = e.taskId;
            next.areaId = e.areaId;
            next.title = e.label ?? undefined; // the session's REAL task title
            if (e.model) next.model = e.model; // keep last known model across idle
          }
          const feed =
            e.status === "working" && e.taskId
              ? pushFeed(s.feed, {
                  t: e.t,
                  glyph: AGENT_GLYPH[prev.id] ?? "pulse",
                  kind: "work",
                  // prefer the session's real title; the taskId label is only a repo/area
                  // anchor for an unidentified session (never the mechanism-name leak)
                  // never a raw node id ("Forge → j.praxis.1" showed on the HUD 2026-10-01):
                  // mission nodes are journey sprouts the graph map may not hold yet
                  text: `${prev.name} → ${e.label ?? nodeLabel(e.taskId) ?? s.journey.find((m) => m.id === e.taskId)?.label ?? "its task"}`,
                  refId: e.taskId,
                  areaId: e.areaId,
                })
              : s.feed;
          return { agents: { ...s.agents, [e.agentId!]: next }, feed };
        });
        break;
      }
      case "agent:thinking": {
        if (!e.agentId) return;
        set((s) => {
          const prev = s.agents[e.agentId!];
          if (!prev) return {};
          return {
            agents: { ...s.agents, [e.agentId!]: { ...prev, thought: e.thought, lastActive: e.t } },
            ticker: e.thought ? { name: prev.name, role: prev.role, thought: e.thought } : s.ticker,
          };
        });
        break;
      }
      case "agent:handoff": {
        if (!e.agentId || !e.toAgentId) return;
        set((s) => {
          const from = s.agents[e.agentId!];
          const to = s.agents[e.toAgentId!];
          if (!from || !to) return {};
          return {
            feed: pushFeed(s.feed, {
              t: e.t,
              glyph: AGENT_GLYPH[from.id] ?? "pulse",
              kind: "work",
              text: `${from.name} → ${to.name} · handoff`,
              refId: e.taskId,
              areaId: e.areaId,
            }),
            ticker: { name: from.name, role: from.role, thought: `handing off to ${to.name}` },
          };
        });
        break;
      }
      case "task:start": {
        if (!e.taskId) return;
        set((s) => ({
          tasks: { ...s.tasks, [e.taskId!]: { progress: 0, active: true, lastTouch: e.t } },
        }));
        break;
      }
      case "task:progress": {
        if (!e.taskId) return;
        set((s) => {
          const prev = s.tasks[e.taskId!] ?? { progress: 0, active: true, lastTouch: e.t };
          return {
            tasks: {
              ...s.tasks,
              [e.taskId!]: { progress: e.progress ?? prev.progress, active: true, lastTouch: e.t },
            },
          };
        });
        break;
      }
      case "task:stop": {
        // stopped without finishing (failed / queued): no longer active, progress kept
        if (!e.taskId) return;
        set((s) => {
          const prev = s.tasks[e.taskId!];
          if (!prev) return {};
          return { tasks: { ...s.tasks, [e.taskId!]: { ...prev, active: false, lastTouch: e.t } } };
        });
        break;
      }
      case "task:complete": {
        if (!e.taskId) return;
        set((s) => {
          const node = buildGraph().byId.get(e.taskId!);
          return {
            tasks: { ...s.tasks, [e.taskId!]: { progress: 1, active: false, lastTouch: e.t } },
            feed: pushFeed(s.feed, {
              t: e.t,
              glyph: AREA_GLYPH[node?.areaId ?? ""] ?? "pulse",
              kind: "done",
              text: `${node?.label ?? e.taskId} · complete`,
              refId: e.taskId,
              areaId: node?.areaId ?? undefined,
            }),
          };
        });
        break;
      }
      case "file:created": {
        if (!e.nodeId) return;
        set((s) => {
          const entry: FileBirth = {
            id: e.nodeId!,
            label: e.label ?? "file",
            path: e.path,
            taskId: e.taskId,
            areaId: e.areaId,
            at: e.t,
          };
          const recentFiles = [entry, ...s.recentFiles.filter((f) => f.id !== entry.id)].slice(0, 14);
          return {
            recentFiles,
            feed: pushFeed(s.feed, {
              t: e.t,
              glyph: "files",
              kind: "file",
              text: `${entry.label} · born`,
              refId: entry.id,
              areaId: entry.areaId,
            }),
          };
        });
        break;
      }
      case "memory:updated": {
        set((s) => ({
          feed: pushFeed(s.feed, {
            t: e.t,
            glyph: "praxis",
            kind: "memory",
            text: e.label ? `memory · ${e.label}` : "memory updated",
            refId: e.nodeId,
            areaId: e.areaId,
          }),
        }));
        break;
      }
      case "journey:handoff": {
        if (!e.taskId || !e.nextId) return;
        set((s) => {
          const node = buildGraph().byId.get(e.nextId!);
          const fromLabel = nodeLabel(e.taskId) ?? e.taskId!;
          const toLabel = nodeLabel(e.nextId) ?? e.nextId!;
          return {
            feed: pushFeed(s.feed, {
              t: e.t,
              glyph: AREA_GLYPH[e.areaId ?? node?.areaId ?? ""] ?? "pulse",
              kind: "work",
              text: `${fromLabel} ↦ ${toLabel}`,
              refId: e.nextId,
              areaId: e.areaId ?? node?.areaId ?? undefined,
            }),
          };
        });
        break;
      }
      case "journey:status": {
        // REAL work moved a milestone along the plan (spec §B.4/B.5). Patch the
        // milestone's status in the journey model, mirror it onto the live graph
        // node (keeps brain-view thinking-breath/colour in sync), persist the
        // override so it survives reload, and bump graphVersion so labels/panels
        // re-read. The runtime re-slots the corridor off the same journey:status
        // event (see runtime.onEvent). No-op when the status is unchanged.
        if (!e.taskId || !e.journeyStatus) return;
        const nextStatus = e.journeyStatus;
        set((s) => {
          const cur = s.journey.find((m) => m.id === e.taskId);
          if (!cur || cur.status === nextStatus) return {};
          // Don't reopen a SHIPPED milestone from the soft "active" signal (a live
          // session / running lane keyword-matched to it). Only an explicit completion
          // (done) or a manual re-plan should move a done milestone; a coarse activity
          // touch must never silently un-ship finished work.
          if (nextStatus === "active" && cur.status === "done") return {};
          const journey = s.journey.map((m) =>
            m.id === e.taskId ? { ...m, status: nextStatus } : m,
          );
          // mirror onto the live graph node (survives a rebuild; graph.ts owns the map)
          setMilestoneStatus(e.taskId!, nextStatus);
          const node = buildGraph().byId.get(e.taskId!);
          // persist the delta on top of the authored base
          _statusOverrides[e.taskId!] = nextStatus;
          saveStatusOverrides(_statusOverrides);
          const label = nodeLabel(e.taskId) ?? e.taskId!;
          return {
            journey,
            graphVersion: s.graphVersion + 1,
            feed: pushFeed(s.feed, {
              t: e.t,
              glyph: AREA_GLYPH[e.areaId ?? node?.areaId ?? ""] ?? "pulse",
              kind: nextStatus === "done" ? "done" : "work",
              text: `${label} · ${nextStatus}`,
              refId: e.taskId,
              areaId: e.areaId ?? node?.areaId ?? undefined,
            }),
          };
        });
        break;
      }
      default:
        break;
    }
  },
}));
