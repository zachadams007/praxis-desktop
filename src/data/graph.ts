/**
 * The brain graph - static topology + deterministic SINGLE-PLANE radial layout.
 *
 * R3 remodel (round3-remodel-lock §R1/R7): 3D LOOK, 2D ORGANIZATION. Everything
 * lays out on the XY plane facing the camera - a map, not a void. Five areas at
 * even angles (start top, clockwise); each area's milestones CHAIN outward along
 * its radial axis (time flows outward: done nearest the brain). z carries NO
 * information - only a small deterministic jitter for parallax.
 *
 * Structure (locked with the owner):
 *   tier 0  HUB        the bright orchestrator at the centre
 *   tier 1  CLUSTER    editable initiatives branching off the core (3–8; the
 *                      set lives in CLUSTER_SPECS and re-evens by count)
 *   tier 2  TASK       work branching off each area
 *   tier 3  DETAIL     docs / memory / files branching off each task (deepest)
 *
 * AGENTS are NOT nodes here - they are bright bodies that travel and ATTACH to
 * whatever task they're firing on (see store + Agents.tsx). The same agent can
 * appear under Catalyzed or Praxis depending on its current work.
 *
 * Layout is fully deterministic (seeded PRNG) so the brain is stable across runs -
 * essential for filmable, reproducible footage.
 */

import { hierarchy, tree } from "d3-hierarchy";
import { AUTHORED_MILESTONES, type JourneyMilestone, type MilestoneStatus } from "./journey";

export type NodeTier = 0 | 1 | 2 | 3;
export type NodeKind = "hub" | "area" | "task" | "doc" | "memory" | "file";

export interface BrainNode {
  id: string;
  tier: NodeTier;
  kind: NodeKind;
  label: string;
  parentId: string | null;
  /** The tier-1 area this node rolls up to (null only for the hub). */
  areaId: string | null;
  pos: [number, number, number];
  /** Base render radius. */
  size: number;
  /** 0..1 - how "alive" this lane is at rest (seeds idle ambient firing density). */
  baseEnergy: number;

  // --- planning fields (journey mode; tasks only, optional/defaulted) ---
  /** Drives front/back placement on the time-corridor. */
  status?: MilestoneStatus;
  /** Within-branch sequence along the time axis (lower = sooner). */
  order?: number;
  /** Human time label shown on the node in journey mode. */
  eta?: string;
}

export interface BrainEdge {
  id: string;
  /** parent node id */
  a: string;
  /** child node id */
  b: string;
  areaId: string;
  /** tier of the child (1=hub→area, 2=area→task, 3=task→detail). */
  tier: NodeTier;
}

export interface AgentDef {
  id: string;
  /** Short display name (the agent's identity). */
  name: string;
  /** Role / specialty. */
  role: string;
  /**
   * INFRA agents are the invisible brain/self-improvement ENGINE (Hermes) and its
   * internal plumbing (Relay routing, Ledger records) - NOT peripheral task-workers.
   * They stay in AGENTS so dashboards + real-event routing can resolve their ids,
   * but the brain scene must NOT render them as orbiting peripheral chips: Hermes is
   * represented AT the Praxis core, and Relay/Ledger simply don't get a chip.
   * (brain/AgentField + brain/Labels filter on this; runtime keeps them for id lookup.)
   */
  infra?: boolean;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const R_AREA = 17.5; // hub → area medallion distance (clear of the core's glow)

// Tier-depth shells (volumetric-constrained remodel, 2026-06-14 - supersedes the
// strict-planar "z carries no info" half of round3-remodel-lock R1). The core
// renders at the origin; each outward tier steps a modest amount AWAY from the
// camera, so the tree reads as a real volume receding into depth under the
// fixed 12° downtilt while the radial XY map stays legible. Magnitude is small
// (a few world units/tier) on purpose - depth is parallax, not a tunnel.
export const TIER_Z: Record<NodeTier, number> = { 0: 0, 1: -3, 2: -6.5, 3: -9 };

// hub 11 → rendered core ≈ 8.6 world radius (+ shells/bloom) ≈ 30-33% of
// viewport height at the overview framing (dist 64, fov 50) - the R4/R5 bar
const SIZE = { hub: 11, area: 1.12, task: 0.6, detail: 0.42 } as const;

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) - stable layout, no Math.random()
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Small vector helpers (plain tuples - this module stays free of three.js)
// ---------------------------------------------------------------------------

type V3 = [number, number, number];

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
/** In-plane tangent (90° CCW from the radial direction). */
const tangentOf = (dir: V3): V3 => [-dir[1], dir[0], 0];

// ---------------------------------------------------------------------------
// Content - the owner's real initiatives (authentic for filming)
// ---------------------------------------------------------------------------

interface AreaSpec {
  id: string;
  label: string;
  dir: V3;
  energy: number; // resting liveliness
}

/**
 * The EDITABLE top-level cluster set (spec: 3–8 projects; auto-rebalances).
 * Order around the ring is chosen so adjacent accent hues stay distinct
 * (tokens.ts DEFAULT_AREA_HUES). Add/remove an entry and the whole map
 * re-evens - the angle is derived from the live count, never hardcoded.
 */
const CLUSTER_SPECS: { id: string; label: string; energy: number }[] = [
  { id: "catalyzed", label: "Catalyzed Alpha", energy: 0.9 },
  { id: "ventures", label: "Ventures", energy: 0.7 },
  { id: "finance", label: "Finance", energy: 0.6 }, // usage/money/ops + the Trading Bot track
  { id: "studio", label: "Studio", energy: 0.66 },
  { id: "praxis", label: "Praxis", energy: 1.0 },
  { id: "learnai", label: "Learning AI", energy: 0.72 },
];

/** Number of top-level clusters - drives the even radial spread (spec: 3–8). */
export const CLUSTER_COUNT = CLUSTER_SPECS.length;

// PLANAR radial directions (lock R1/R7): N even angles on the XY plane, starting
// at the top and walking clockwise, where N = the live cluster count so the map
// auto-rebalances. z is ALWAYS 0 here - depth is parallax jitter per node, never
// information. Tasks are NOT listed here - they come from the canonical journey
// model (journey.ts), so the brain and the plan stay two projections of one model.
const areaAngle = (i: number, n: number = CLUSTER_COUNT) =>
  Math.PI / 2 - i * ((Math.PI * 2) / n); // top, clockwise
export const planarDir = (i: number, n: number = CLUSTER_COUNT): V3 => [
  Math.cos(areaAngle(i, n)),
  Math.sin(areaAngle(i, n)),
  0,
];

const AREA_SPECS: AreaSpec[] = CLUSTER_SPECS.map((c, i) => ({
  id: c.id,
  label: c.label,
  dir: planarDir(i),
  energy: c.energy,
}));

/** Cluster ids in ring order (top, clockwise) - the canonical sector ordering. */
export const CLUSTER_ORDER: string[] = AREA_SPECS.map((a) => a.id);

// Keys are the milestone (tier-2 task) ids from journey.ts. Labels are short (≤ ~22 chars) so
// they render as node captions.
type Detail = { kind: NodeKind; label: string };
const TASK_DETAILS: Record<string, Detail[]> = {
  // ---- Catalyzed Alpha ----
  "t.catalyzed.feed": [{ kind: "file", label: "FriendsFeed.tsx" }, { kind: "file", label: "aiRelevance.ts" }, { kind: "doc", label: "feed-algorithm.md" }],
  "t.catalyzed.algo": [{ kind: "file", label: "EngineCore.tsx" }, { kind: "file", label: "useStoryScroll.ts" }, { kind: "doc", label: "scoring-framework.md" }],
  "t.catalyzed.ops": [{ kind: "file", label: "ApiQuotaBoard.tsx" }, { kind: "file", label: "MyDesk.tsx" }, { kind: "memory", label: "ops-surfaces" }],
  "t.catalyzed.terminal": [{ kind: "file", label: "terminalFeed.ts" }, { kind: "file", label: "form4_miner.py" }, { kind: "doc", label: "bloomberg-terminal.md" }],
  "t.catalyzed.picks": [{ kind: "file", label: "scoring.ts" }, { kind: "file", label: "ranking.ts" }, { kind: "doc", label: "weight-calibration.md" }],
  "t.catalyzed.alerts": [{ kind: "file", label: "socialAlerts.ts" }, { kind: "doc", label: "limiter-plan.md" }, { kind: "memory", label: "market-signals" }],
  // ---- Finance (now includes the Trading Bot track) ----
  "t.finance.ledger": [{ kind: "file", label: "apiUsage.ts" }, { kind: "file", label: "UsagePanel.tsx" }, { kind: "file", label: "ApiQuotaBoard.tsx" }],
  "t.finance.dash": [{ kind: "file", label: "MyDesk.tsx" }, { kind: "file", label: "admin.ts" }, { kind: "doc", label: "data-sources.md" }],
  "t.finance.budget": [{ kind: "file", label: "operatorSafety.ts" }, { kind: "doc", label: "limiter-plan.md" }, { kind: "memory", label: "refresh-limiter" }],
  "t.finance.tradingbot": [{ kind: "doc", label: "trading-bot-research.md" }, { kind: "file", label: "strategy.py" }, { kind: "file", label: "backtest.py" }, { kind: "file", label: "kill_switch.py" }],
  "t.finance.revenue": [{ kind: "doc", label: "usage-report.md" }, { kind: "doc", label: "roadmap.md" }, { kind: "memory", label: "free-data-policy" }],
  // ---- Studio ----
  "t.studio.mpt": [{ kind: "file", label: "webui.bat" }, { kind: "file", label: "config.toml" }, { kind: "memory", label: "mpt-setup" }],
  "t.studio.launch": [{ kind: "file", label: "catalyzed_generate.py" }, { kind: "doc", label: "publish-notes.md" }, { kind: "memory", label: "reference-clips" }],
  "t.studio.autopost": [{ kind: "file", label: "autopost.py" }, { kind: "doc", label: "format-notes.md" }, { kind: "memory", label: "publish-queue" }],
  "t.studio.hooks": [{ kind: "file", label: "hooks_ab.py" }, { kind: "doc", label: "visual-quality-bar.md" }, { kind: "memory", label: "perf-feedback" }],
  // ---- Praxis ----
  "t.praxis.brain": [{ kind: "file", label: "Hub.tsx" }, { kind: "file", label: "ClusterField.tsx" }, { kind: "doc", label: "round4-connectome.md" }],
  "t.praxis.gesture": [{ kind: "file", label: "useHandGesture.ts" }, { kind: "file", label: "GesturePanel.tsx" }, { kind: "file", label: "CameraRig.tsx" }],
  "t.praxis.journey": [{ kind: "file", label: "journeyLayout.ts" }, { kind: "file", label: "JourneyChrome.tsx" }, { kind: "doc", label: "journey-spec.md" }],
  "t.praxis.orchestrator": [{ kind: "file", label: "parse.ts" }, { kind: "file", label: "respond.ts" }, { kind: "file", label: "DumpBox.tsx" }],
  "t.praxis.flightdeck": [{ kind: "file", label: "DeckApp.tsx" }, { kind: "file", label: "DeckDock.tsx" }, { kind: "file", label: "model.ts" }, { kind: "file", label: "flightdeck.rs" }],
  "t.praxis.agentviz": [{ kind: "file", label: "AgentField.tsx" }, { kind: "file", label: "PulseField.tsx" }, { kind: "file", label: "modelTint.ts" }],
  "t.praxis.realeventbus": [{ kind: "file", label: "useRealEvents.ts" }, { kind: "file", label: "transcript_tailer.rs" }, { kind: "file", label: "session_poller.rs" }],
  "t.praxis.costplan": [{ kind: "file", label: "usePraxisStore.ts" }, { kind: "doc", label: "three-phase-roadmap.md" }, { kind: "memory", label: "flight-deck" }],
  "t.praxis.runtime": [{ kind: "file", label: "runtime.ts" }, { kind: "file", label: "eventBus.ts" }, { kind: "file", label: "schema.ts" }],
  "t.ventures.monetize": [{ kind: "doc", label: "usage-report.md" }, { kind: "doc", label: "roadmap.md" }, { kind: "memory", label: "free-data-policy" }],
  "t.learnai.skills": [{ kind: "file", label: "memprompt" }, { kind: "file", label: "offload" }, { kind: "file", label: "overnight" }, { kind: "file", label: "skill-scout" }],
  "t.learnai.workflows": [{ kind: "file", label: "design→code" }, { kind: "file", label: "offload router" }, { kind: "file", label: "memory + intent" }, { kind: "file", label: "Flight Deck flow" }],
  "t.learnai.agents": [{ kind: "file", label: "Codex CLI" }, { kind: "file", label: "sonnet-worker" }, { kind: "memory", label: "Hermes Agent" }, { kind: "file", label: "subagent fan-out" }],
  "t.learnai.subs": [{ kind: "file", label: "Claude Max" }, { kind: "file", label: "Hume EVI" }, { kind: "file", label: "Groq" }, { kind: "file", label: "Cursor" }],
  // t.learnai.decisions: intentionally minimal for now (deterministic stub)
};

const FALLBACK_KINDS: NodeKind[] = ["doc", "file", "memory"];

// ── Learning AI: live captured-skill artifacts ────────────────────────────────
// The skill-capture loop (orchestrator/skills.ts) persists reusable skills Praxis
// learned. They surface here as tier-3 artifacts under the "Skills" task of the
// Learning AI cluster - same {kind:"file", label} shape as the authored skill
// nodes (memprompt/offload/…), so they render identically with no new styling.
// Default is EMPTY, so with no captured skills the graph is byte-for-byte what it
// was before. `mergeSkillArtifacts` is the one additive entry point: the frontend
// loader (skills.ts loadSkills → labels) calls it, and it invalidates the graph
// cache so the next buildGraph() folds the skills in.
const SKILLS_TASK_ID = "t.learnai.skills";
let liveSkillDetails: Detail[] = [];

/**
 * Merge captured-skill names into the Learning AI "Skills" task as artifacts.
 * Additive + idempotent: labels are trimmed, de-duped, capped, and the graph
 * cache is invalidated so the next buildGraph() picks them up. Guarded so a bad
 * input (non-array) is a no-op rather than a crash. Frontend-only (no styling).
 */
export function mergeSkillArtifacts(labels: string[]): void {
  if (!Array.isArray(labels)) return;
  const seen = new Set<string>();
  const details: Detail[] = [];
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const label = raw.trim().slice(0, 22); // match the ≤22-char caption budget
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    details.push({ kind: "file", label });
    if (details.length >= 12) break; // keep the leaf fan sane
  }
  liveSkillDetails = details;
  _cache = null; // force a rebuild so the new artifacts land in the tidy tree
}

// ── Real created-file artifacts (spec §B.8) ───────────────────────────────────
// The file watcher (fileWatch.ts) reports real files agents write. Each is mapped
// to a milestone (journey.milestoneForSignal) and attached here as a tier-3 artifact
// leaf under that task - the file-birth equivalent of mergeSkillArtifacts, and the
// one additive entry point for it. Additive + capped (last N per task) so a busy
// session doesn't blow out the leaf fan. Default EMPTY → the graph is byte-for-byte
// unchanged until a real file actually lands.
const FILE_ARTIFACT_CAP = 5;
const liveFileArtifacts = new Map<string, Detail[]>();

/**
 * Attach a REAL created file as a tier-3 artifact leaf on `taskId`. Idempotent per
 * label (a re-write of the same file doesn't duplicate), keeps only the last
 * FILE_ARTIFACT_CAP files per task, and invalidates the graph cache so the next
 * buildGraph() folds it into the tidy tree. Guarded - bad input is a no-op.
 */
export function attachCreatedFileArtifact(taskId: string, label: string): void {
  if (typeof taskId !== "string" || typeof label !== "string") return;
  const clean = label.trim().slice(0, 22); // ≤22-char caption budget, like skills
  if (!taskId || !clean) return;
  const key = clean.toLowerCase();
  const list = (liveFileArtifacts.get(taskId) ?? []).filter((d) => d.label.toLowerCase() !== key);
  list.push({ kind: "file", label: clean });
  while (list.length > FILE_ARTIFACT_CAP) list.shift(); // drop the oldest, keep last N
  liveFileArtifacts.set(taskId, list);
  _cache = null; // force a rebuild so the new artifact lands in the tidy tree
}

/** Real tier-3 details for a task (deterministic fallback for live sprouts). */
function detailsFor(taskId: string, taskLabel: string): Detail[] {
  let base: Detail[];
  const real = TASK_DETAILS[taskId];
  if (real) {
    // The Learning AI "Skills" task folds in any live captured skills alongside
    // its authored artifacts (deduped by label, live wins so a re-captured skill
    // doesn't double up with a same-named authored one).
    if (taskId === SKILLS_TASK_ID && liveSkillDetails.length) {
      const authoredLabels = new Set(real.map((d) => d.label.toLowerCase()));
      const extras = liveSkillDetails.filter((d) => !authoredLabels.has(d.label.toLowerCase()));
      base = [...real, ...extras];
    } else {
      base = real;
    }
  } else {
    // sprouted tasks (brain-dump ingest) have no authored artifacts - give a small
    // deterministic stand-in so the branch still ends in leaf-twigs
    const rng = mulberry32(hashStr(taskId));
    const slug = taskLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 14) || "task";
    const kind = FALLBACK_KINDS[Math.floor(rng() * FALLBACK_KINDS.length)];
    base = [
      { kind: "doc", label: `${slug}.md` },
      { kind, label: slug },
    ];
  }
  // fold in REAL created files mapped to this task (spec §B.8) - additive + deduped
  const files = liveFileArtifacts.get(taskId);
  if (files && files.length) {
    const have = new Set(base.map((d) => d.label.toLowerCase()));
    const extras = files.filter((d) => !have.has(d.label.toLowerCase()));
    if (extras.length) base = [...base, ...extras];
  }
  return base;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface Graph {
  nodes: BrainNode[];
  edges: BrainEdge[];
  byId: Map<string, BrainNode>;
  /** Task ids grouped by area (for the timeline + agent travel). */
  tasksByArea: Map<string, string[]>;
  /** All task ids, flat. */
  taskIds: string[];
  agents: AgentDef[];
}

/**
 * Canonical agent fleet codenames (locked 2026-06-29).
 * Tint families are declared in brain/modelTint.ts:
 *   a.praxis  → hermes (electric cyan) - orchestrator
 *   a.forge   → opus   (violet) - Claude Code coder
 *   a.vega    → codex  (teal) - Codex coder
 *   a.quill   → cursor (amber) - Cursor coder
 *   a.atlas   → codex  (teal) - Codex computer-use operator
 *   a.sage    → sonnet (gold) - research
 *   a.lens    → sonnet (gold) - QA / inspector
 *   a.ledger  → sonnet (gold) - memory / records
 *   a.relay   → sonnet (gold) - handoff router
 *   a.hermes  → hermes (cyan) - brain engine
 */
export const AGENTS: AgentDef[] = [
  { id: "a.praxis",  name: "Praxis",  role: "Orchestrator" },
  { id: "a.forge",   name: "Forge",   role: "Claude Coder" },
  { id: "a.vega",    name: "Vega",    role: "Codex Coder" },
  { id: "a.quill",   name: "Quill",   role: "Cursor Coder" },
  { id: "a.atlas",   name: "Atlas",   role: "Operator" },
  { id: "a.sage",    name: "Sage",    role: "Research" },
  { id: "a.lens",    name: "Lens",    role: "QA" },
  // INFRA - the brain engine + its plumbing. Kept in the roster for dashboards /
  // id resolution, but NOT rendered as peripheral orbiting chips (Hermes lives at
  // the core; see AgentField/Labels + the `infra` flag above).
  { id: "a.ledger",  name: "Ledger",  role: "Records",      infra: true },
  { id: "a.relay",   name: "Relay",   role: "Router",       infra: true },
  { id: "a.hermes",  name: "Hermes",  role: "Brain Engine", infra: true },
];

let _cache: Graph | null = null;

// ── Runtime milestone-status overrides (spec §B.4) ────────────────────────────
// REAL work (a mapped flow lane / live session, via the journey:status event) moves
// a milestone along the plan. The store persists those deltas and pushes them here so
// a graph REBUILD (skill/file-artifact cache invalidation) preserves the live status
// instead of snapping every task node back to its authored seed. Keyed by milestone
// (tier-2 task) id; empty by default → the graph is byte-for-byte the authored plan.
const _statusOverrides = new Map<string, MilestoneStatus>();

/** Apply a runtime status override to a milestone (spec §B.4): remember it (so the
 *  next buildGraph keeps it) AND mutate the live node in place if the graph is built. */
export function setMilestoneStatus(id: string, status: MilestoneStatus): void {
  _statusOverrides.set(id, status);
  const n = _cache?.byId.get(id);
  if (n) n.status = status;
}

/** Seed many status overrides at boot from the persisted journey-status map. Applies
 *  to the current cache if one is already built. */
export function seedMilestoneStatuses(overrides: Record<string, MilestoneStatus>): void {
  for (const [id, st] of Object.entries(overrides)) _statusOverrides.set(id, st);
  if (_cache) {
    for (const [id, st] of _statusOverrides) {
      const n = _cache.byId.get(id);
      if (n) n.status = st;
    }
  }
}

const AREA_BY_ID = new Map(AREA_SPECS.map((a) => [a.id, a]));

// ---------------------------------------------------------------------------
// Layout - radial TIDY TREE (d3-hierarchy)
// ---------------------------------------------------------------------------
// Each area's subtree (area → tasks → details) is laid out by d3.tree(), the
// Reingold–Tilford tidy-tree algorithm: siblings never overlap, every parent
// sits centered over its children, and each subtree owns a disjoint band. We
// map the tree's BREADTH axis to ANGLE within the area's wedge (centered on its
// even radial spoke) and its DEPTH axis to RADIUS outward from the medallion -
// so the brain reads as the clean, organized branching the owner drew by hand
// (docs IMG_1231) instead of a hand-rolled random fan. Fully deterministic:
// d3.tree is purely combinatorial and the input order is stable, so footage
// stays byte-for-byte reproducible (no Math.random / no PRNG in the shape).

// A WIDE, SHALLOW fan (not a long thin radial sliver): the subtree fills most of
// its sector arc and stays shallow in radius, so a focused cluster reads as a
// balanced tree that fills the frame instead of overflowing as a sliver. With 6
// clusters (60° each) 0.92 fill = ~55° used, ~5° clean gap → no neighbour overlap.
const WEDGE_FILL = 0.99; // fraction of the 2π/N sector a subtree may occupy (uses nearly all the inter-cluster gap so the detail leaves fan wide along the arc)
const TASK_RADIAL_SPAN = 23; // medallion → deepest detail, outward - pushing the leaves further out spreads their (long) labels so they stop overlapping
const Z_INSHELL = 0.4; // tiny per-node z scatter on top of the tier shell (parallax life)

type TreeDatum = { id: string; children?: TreeDatum[] };
interface TaskSpec {
  id: string;
  detailIds: string[];
}

/**
 * Tidy radial layout for ONE area's subtree. Returns world positions for the
 * area medallion + every task + every detail, keyed by id. The tidy root is
 * centered over its subtree, then we recenter on the area's spoke, so the
 * medallion always lands exactly on its even N-spoke ray (the recognizable
 * overview is preserved) while the tasks/details fan cleanly into the wedge.
 */
function layoutArea(area: AreaSpec, tasks: TaskSpec[]): Map<string, V3> {
  const baseAngle = Math.atan2(area.dir[1], area.dir[0]);
  const root = hierarchy<TreeDatum>({
    id: area.id,
    children: tasks.map((t) => ({ id: t.id, children: t.detailIds.map((d) => ({ id: d })) })),
  });
  const layout = tree<TreeDatum>()
    .size([WEDGE_FILL * ((Math.PI * 2) / CLUSTER_COUNT), TASK_RADIAL_SPAN])
    .separation((a, b) => (a.parent === b.parent ? 1.7 : 2.7));
  const placed = layout(root);
  const center = placed.x; // recenter the whole subtree on the area's spoke
  const out = new Map<string, V3>();
  placed.each((n) => {
    const angle = baseAngle + (n.x - center);
    const radius = R_AREA + n.y;
    const tier: NodeTier = n.depth === 0 ? 1 : n.depth === 1 ? 2 : 3;
    const zj = (mulberry32(hashStr(n.data.id))() * 2 - 1) * Z_INSHELL;
    out.set(n.data.id, [Math.cos(angle) * radius, Math.sin(angle) * radius, TIER_Z[tier] + zj]);
  });
  return out;
}

/** Detail (tier-3) child ids of a task, from the live graph. */
function childDetailIds(g: Graph, taskId: string): string[] {
  return g.nodes.filter((n) => n.parentId === taskId && n.tier === 3).map((n) => n.id);
}

export function buildGraph(): Graph {
  if (_cache) return _cache;

  const nodes: BrainNode[] = [];
  const edges: BrainEdge[] = [];
  const tasksByArea = new Map<string, string[]>();
  const taskIds: string[] = [];

  // tier 0 - hub (labelled "Orchestrator" so it doesn't collide with the Praxis
  // *initiative* label; the product itself is branded PRAXIS in the HUD)
  nodes.push({
    id: "hub",
    tier: 0,
    kind: "hub",
    label: "Orchestrator",
    parentId: null,
    areaId: null,
    pos: [0, 0, 0],
    size: SIZE.hub,
    baseEnergy: 1,
  });

  for (const area of AREA_SPECS) {
    const milestones = AUTHORED_MILESTONES.filter((m) => m.areaId === area.id).sort(
      (a, b) => a.order - b.order,
    );
    // resolve each task's details up front (deterministic) so the WHOLE area
    // subtree can be laid out as one tidy tree (no overlaps, clean wedges)
    const taskDetails = milestones.map((m) => ({ m, details: detailsFor(m.id, m.label) }));
    const posMap = layoutArea(
      area,
      taskDetails.map((td) => ({
        id: td.m.id,
        detailIds: td.details.map((_, di) => `${td.m.id}.d${di}`),
      })),
    );
    const areaPos: V3 = posMap.get(area.id) ?? [area.dir[0] * R_AREA, area.dir[1] * R_AREA, TIER_Z[1]];

    nodes.push({
      id: area.id,
      tier: 1,
      kind: "area",
      label: area.label,
      parentId: "hub",
      areaId: area.id,
      pos: areaPos,
      size: SIZE.area,
      baseEnergy: area.energy,
    });
    edges.push({ id: `e.hub.${area.id}`, a: "hub", b: area.id, areaId: area.id, tier: 1 });

    const taskList: string[] = [];
    taskDetails.forEach(({ m, details }) => {
      const tid = m.id;
      const rng = mulberry32(hashStr(tid));
      const taskPos: V3 = posMap.get(tid) ?? areaPos;

      nodes.push({
        id: tid,
        tier: 2,
        kind: "task",
        label: m.label,
        parentId: area.id,
        areaId: area.id,
        pos: taskPos,
        size: SIZE.task,
        baseEnergy: area.energy * (0.5 + rng() * 0.5),
        // runtime override (real work) wins over the authored seed, so a rebuild
        // (skill/file-artifact invalidation) keeps the live plan status (spec §B.4)
        status: _statusOverrides.get(tid) ?? m.status,
        order: m.order,
        eta: m.eta,
      });
      edges.push({ id: `e.${area.id}.${tid}`, a: area.id, b: tid, areaId: area.id, tier: 2 });
      taskList.push(tid);
      taskIds.push(tid);

      // tier 3 - details are the tidy-tree LEAVES of this task (clean fan,
      // one wedge each, no overlap), positions straight from the layout
      details.forEach((d, di) => {
        const did = `${tid}.d${di}`;
        const drng = mulberry32(hashStr(did));
        const dPos: V3 = posMap.get(did) ?? taskPos;
        nodes.push({
          id: did,
          tier: 3,
          kind: d.kind,
          label: d.label,
          parentId: tid,
          areaId: area.id,
          pos: dPos,
          size: SIZE.detail,
          baseEnergy: 0.2 + drng() * 0.3,
        });
        edges.push({ id: `e.${tid}.${did}`, a: tid, b: did, areaId: area.id, tier: 3 });
      });
    });

    tasksByArea.set(area.id, taskList);
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  _cache = { nodes, edges, byId, tasksByArea, taskIds, agents: AGENTS };
  return _cache;
}

/**
 * Append a brain-dump milestone to the live graph (Phase-1 demo ingest).
 * Mutates the cached graph in place so every consumer (HUD lookups, labels,
 * the runtime) sees the same object; the runtime activates a preallocated
 * slot for it when the `journey:sprout` event lands. Returns the new node.
 */
export function sproutTask(m: JourneyMilestone): BrainNode {
  const g = buildGraph();
  const area = AREA_BY_ID.get(m.areaId) ?? AREA_SPECS[1]; // default: praxis
  const siblings = g.tasksByArea.get(area.id) ?? [];
  // recompute the area's tidy tree WITH the new task appended and read just the
  // new task's slot (siblings keep their positions; the runtime eases the new
  // node in). Deterministic + overlap-free, same algorithm as the static build.
  const posMap = layoutArea(area, [
    ...siblings.map((sid) => ({ id: sid, detailIds: childDetailIds(g, sid) })),
    { id: m.id, detailIds: [] },
  ]);
  const pos: [number, number, number] =
    posMap.get(m.id) ?? [area.dir[0] * (R_AREA + 9), area.dir[1] * (R_AREA + 9), TIER_Z[2]];
  const rng = mulberry32(hashStr(m.id));

  const node: BrainNode = {
    id: m.id,
    tier: 2,
    kind: "task",
    label: m.label,
    parentId: area.id,
    areaId: area.id,
    pos,
    size: SIZE.task,
    baseEnergy: area.energy * (0.5 + rng() * 0.5),
    status: m.status,
    order: m.order,
    eta: m.eta,
  };
  g.nodes.push(node);
  g.byId.set(node.id, node);
  g.tasksByArea.set(area.id, [...siblings, node.id]);
  g.taskIds.push(node.id);
  g.edges.push({ id: `e.${area.id}.${node.id}`, a: area.id, b: node.id, areaId: area.id, tier: 2 });
  return node;
}
