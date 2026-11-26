/**
 * BrainRuntime - the imperative engine behind the visual.
 *
 * It owns ALL high-frequency state as flat typed arrays and integrates it every
 * frame: node glow (decays toward an ambient resting level, bumps on events),
 * travelling neuron pulses (a pooled particle system along edges), and agent bodies
 * (smoothly fly to and orbit the task they're firing on). It subscribes to the
 * eventBus and maps events → animation. No React, no allocations in `update()`.
 *
 * The R3F components are thin: each frame they read these arrays and copy them into
 * instanced attributes. Swap the mock eventBus for the real one later and this whole
 * engine is unchanged.
 */

import * as THREE from "three";
import type { RootState } from "@react-three/fiber";
import { eventBus } from "@/data/eventBus";
import { buildGraph, type BrainNode } from "@/data/graph";
import { cubicBezierPoint, edgeControlPoints } from "./edgeRoute";
import { modelTint } from "./modelTint";
import { computeJourneyTargets } from "@/data/journeyLayout";
import { journeyDagEdges } from "@/data/journey";
import { buildTimeline, makePlayer } from "@/data/mockTimeline";
import type { PraxisEvent } from "@/data/schema";
import { usePraxisStore } from "@/store/usePraxisStore";
import { getTtsLevel } from "@/voice/micLevel";

const PULSE_MAX = 900;
/** Comet-trail ring buffer length per agent (rendered in AgentField). */
export const TRAIL_LEN = 24;
/** Concurrent agent→agent handoff packets (pooled). */
const HANDOFF_MAX = 16;
/** Concurrent milestone→milestone JOURNEY handoff packets (roadmap-level; pooled). */
const MHANDOFF_MAX = 12;
/** Fraction of a routed transit spent flying IN to the cluster medallion before
 *  riding the branch out to the task (the rest rides the edge chain). */
const TRANSIT_LEAD = 0.34;

// Preallocated headroom so brain-dump milestones can SPROUT live without
// rebuilding any GPU buffers (instanced meshes are sized to capacity once).
const SPARE_NODES = 16;
const SPARE_EDGES = 36; // each sprout takes a parent edge + a journey link

// Morph stagger window: how much of the tween is spent fanning the unfurl
// across tiers/branches (per-node smootherstep does the easing).
const MORPH_STAGGER = 0.35;

export interface AgentRT {
  id: string;
  name: string;
  role: string;
  /** INFRA agent (Hermes brain engine + Relay/Ledger plumbing): kept for event/id
   *  resolution + handoffs, but NEVER rendered as a peripheral orbiting chip - Hermes
   *  is represented AT the core instead (see AgentField/Labels skip on this flag). */
  infra: boolean;
  /** Claude model currently driving this agent (set from the event bus); persists
   *  across idle so a docked chip keeps its identity hint. */
  model?: string;
  /** Precomputed signature colour for `model` (null = unknown → theme accent). */
  modelCol: THREE.Color | null;
  pos: THREE.Vector3;
  anchor: THREE.Vector3;
  attachTask: number; // node index, or -1 when idle
  attachArea: number; // node index of the cluster it's working in, or -1
  /** True iff the CURRENT attachTask came from a real agent:status event (the
   *  real-event bridge or Hermes), not the decorative mock timeline. Gates
   *  spec A.2: only a REAL working-on-this-node agent forces the node
   *  always-visible + gets an orbit; the mock's filler never does. */
  real: boolean;
  intensity: number; // current brightness 0..1
  targetIntensity: number;
  phase: number; // orbit phase
  fireTimer: number; // accumulator for pulse emission
  dockSlot: number; // stable slot for the idle dock arc (all-agent index)
  /** Rank AMONG peripheral (non-infra) agents - drives the visible dock arc spread
   *  so infra agents (no chip) don't leave gaps. -1 for infra agents. */
  dockRank: number;
  trail: Float32Array; // ring buffer of TRAIL_LEN * 3
  trailHead: number;
  // --- routed travel: the agent visibly FLIES to its cluster then rides the
  //     branch out to the task, so you can see WHICH cluster it's working ---
  transit: number; // 0..1 progress while travelling; <0 = settled
  transitFrom: THREE.Vector3; // where this leg launched
  transitDur: number; // seconds for the whole route
  transitEdges: number[]; // area→task edge chain to ride (after the lead-in)
}

export class BrainRuntime {
  readonly g = buildGraph();
  /** Live view of the graph's nodes (sprouts append here too). */
  readonly nodes: BrainNode[] = this.g.nodes;
  /** ACTIVE node count (grows when a brain-dump sprouts). */
  n = this.g.nodes.length;
  /** Allocated capacity - every typed array & instanced mesh is sized to this. */
  readonly cap = this.g.nodes.length + SPARE_NODES;

  // node arrays (sized to `cap`; slots >= n are dormant until a sprout)
  readonly pos: Float32Array;
  readonly activity: Float32Array; // 0..1 current glow
  readonly ambient: Float32Array; // resting target
  readonly reveal: Float32Array; // 0..1 LOD opacity
  readonly tier: Int8Array;
  readonly index = new Map<string, number>();
  readonly areaIndex: Int32Array; // index of this node's AREA node (-1 for hub)
  readonly parentIndex: Int32Array;
  /** 1 = always revealed (each area's FIRST milestone - the R4 overview ring). */
  readonly alwaysOn: Uint8Array;

  // the two layouts of the SAME nodes + the morph between them
  readonly posBrain: Float32Array; // radial nebula (graph.ts layout)
  readonly posJourney: Float32Array; // time-corridor (journeyLayout.ts), eased
  /** Where the corridor layout is HEADED (re-slots ease, never teleport). */
  private readonly posJourneyTarget: Float32Array;
  private journeySettled = true;
  /** 0 = brain, 1 = journey (GSAP-tweened via setMorph). */
  morph = 0;
  private readonly morphDelay: Float32Array; // per-node stagger 0..MORPH_STAGGER
  private readonly morphLift: Float32Array; // per-node transit arc amplitude

  // edges
  readonly eA: Int32Array;
  readonly eB: Int32Array;
  readonly eTier: Int8Array; // 1..3 structural, 4 = journey story-link
  readonly edgeActive: Float32Array;
  // per-edge aggregate of the travelling pulses currently riding it (rebuilt every
  // frame from the pooled pulse system) - so the tube shader can light the exact
  // segment a pulse is on, INDEPENDENT of the pathway's base brightness/LOD. Only
  // the brightest pulse on an edge is kept (a comet head is a single bright point).
  readonly edgePulseT: Float32Array; // head position 0..1 along the A→B Bézier
  readonly edgePulseGlow: Float32Array; // that pulse's current brightness (0 = none)
  readonly edgePulseKind: Float32Array; // 0 = signal (warm) · 1 = memory (cool)
  // Per-node arrival energy. A node lights only after a routed pulse reaches it.
  // 0 at rest → the node render is byte-identical when no pulse is present.
  readonly nodeArrival: Float32Array; // 0..1 arrival flash energy (additive, decaying)
  readonly nodeArrivalKind: Float32Array; // 0 = signal (warm) · 1 = memory (cool)
  // STANDARDIZED "thinking" breath - a slow, uniform appear/reappear on genuinely
  // ACTIVE nodes. `thinkActive` is an eased 0..1 gate (1 only when the node is really
  // active: status "active" OR a real agent is working it; tier-3 leaves inherit their
  // parent task's gate so a task + its children breathe together). `thinkPhase` is a
  // stable per-node phase (children copy the parent's) so the cadence is phase-locked
  // parent↔children. NodeField turns these into a slow scale/glow dip, attenuated by
  // camera proximity so a close-up active node never actually vanishes.
  readonly thinkActive: Float32Array; // 0..1 eased "is this node genuinely active"
  readonly thinkPhase: Float32Array; // stable breath phase (tier-3 inherits parent)
  private readonly _thinkRaw: Float32Array; // scratch: crisp per-frame active (0/1)
  /** ACTIVE edge count (grows when a sprout wires in). */
  edgeCount: number;
  /** Allocated edge capacity. */
  readonly eCap: number;
  private readonly edgeByChild = new Map<number, number>();
  private readonly chainOf = new Map<number, number[]>(); // node idx → edge idxs hub→node

  // pulses (pooled)
  readonly pEdge = new Int32Array(PULSE_MAX).fill(-1);
  readonly pProg = new Float32Array(PULSE_MAX);
  readonly pSpeed = new Float32Array(PULSE_MAX);
  readonly pSeed = new Float32Array(PULSE_MAX); // per-pulse arc seed
  readonly pIntensity = new Float32Array(PULSE_MAX);
  readonly pPos = new Float32Array(PULSE_MAX * 3);
  readonly pBright = new Float32Array(PULSE_MAX);
  /** Motif: 0 = signal (warm), 1 = memory packet (cool, slower, larger). */
  readonly pKind = new Float32Array(PULSE_MAX);
  /** Seconds before this pulse starts. Chains use this to travel edge-by-edge. */
  readonly pDelay = new Float32Array(PULSE_MAX);
  private pHead = 0;

  readonly agents: AgentRT[];
  /** Count of PERIPHERAL (non-infra) agents - the ones that get a chip + dock slot. */
  readonly peripheralCount: number;

  // agent → agent handoff packets (pooled). A packet arcs along the edge between
  // two chips when one agent feeds information to another (agent:handoff event).
  readonly hFrom = new Int32Array(HANDOFF_MAX).fill(-1); // sender agent index
  readonly hTo = new Int32Array(HANDOFF_MAX).fill(-1); // receiver agent index
  readonly hProg = new Float32Array(HANDOFF_MAX);
  readonly hSpeed = new Float32Array(HANDOFF_MAX);
  readonly hIntensity = new Float32Array(HANDOFF_MAX);
  readonly hPos = new Float32Array(HANDOFF_MAX * 3);
  readonly hBright = new Float32Array(HANDOFF_MAX);
  private hHead = 0;

  // milestone → milestone JOURNEY handoffs (pooled). When a milestone completes
  // and feeds the NEXT one down its lane, a warm "work product" packet flows along
  // the roadmap between the two NODE positions (journey:handoff event). Endpoints
  // are node indices, not agents; only legible in the time-corridor, so brightness
  // is gated on the morph (invisible in the brain view, fades across the morph).
  readonly mFrom = new Int32Array(MHANDOFF_MAX).fill(-1); // source node index
  readonly mTo = new Int32Array(MHANDOFF_MAX).fill(-1); // target node index
  readonly mProg = new Float32Array(MHANDOFF_MAX);
  readonly mSpeed = new Float32Array(MHANDOFF_MAX);
  readonly mIntensity = new Float32Array(MHANDOFF_MAX);
  readonly mPos = new Float32Array(MHANDOFF_MAX * 3);
  readonly mBright = new Float32Array(MHANDOFF_MAX);
  private mHead = 0;

  /** Where the camera is currently looking (drives depth-of-field focus). */
  readonly focusTarget = new THREE.Vector3(0, 0, 0);

  /** Mean tier-1 activity - the whole brain's "busyness" (core breath driver). */
  busy = 0;
  /** Spikes when the orchestrator/agents think - the core's "talking" flutter. */
  talk = 0;
  /** Live voice amplitude 0..1 while the orchestrator speaks (Praxis ripple). */
  voice = 0;
  /** Seconds of speech left to play (drives the voice envelope). */
  private speakRemaining = 0;

  // scratch (no per-frame allocation)
  private readonly _a = new THREE.Vector3();
  private readonly _cam = new THREE.Vector3();
  private readonly _camWorld = new THREE.Vector3();
  // camera basis (right/up) so a working agent orbits IN THE VIEW PLANE - a clean
  // billboard circle that reads as an orbit from any camera angle, not edge-on.
  private readonly _camRight = new THREE.Vector3(1, 0, 0);
  private readonly _camUp = new THREE.Vector3(0, 1, 0);
  // routed-pulse scratch (cubic control points + sampled position) - shared edgeRoute
  private readonly _c1 = new Float32Array(3);
  private readonly _c2 = new Float32Array(3);
  private readonly _routePos = new Float32Array(3);
  private readonly _routeOut = new Float32Array(3); // agent transit sample

  // timeline player (owns the MOCK event stream; emits onto the shared eventBus).
  // Its events are tagged `this.mockTick = true` for the duration of the emit so
  // `onEvent` can tell decorative filler apart from real agent work (spec A.2:
  // idle must stay honest - a scripted "agent working on X" must never force a
  // node always-visible or spin up a real-looking orbit).
  private readonly player = makePlayer(buildTimeline(this.g), (e) => {
    // SOURCE TAG (spec §A.1): the event level mirror of `ag.real = !this.mockTick`.
    // buildTimeline already stamps every event `synthetic`; re-assert it here so the
    // contract holds even if a future caller feeds this player an un-stamped stream.
    e.synthetic = true;
    this.mockTick = true;
    eventBus.emit(e);
    this.mockTick = false;
  });
  /** Browser previews stay filmable; the installed app visualizes real events only. */
  private readonly mockEnabled =
    typeof window === "undefined" || !("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
  /** True only while the mock timeline's own emit is on the stack (see above). */
  private mockTick = false;
  private playClock = 0;
  private lastElapsed = -1;

  private unsub: () => void;

  constructor() {
    const { nodes, edges } = this.g;
    this.pos = new Float32Array(this.cap * 3);
    this.posBrain = new Float32Array(this.cap * 3);
    this.posJourney = new Float32Array(this.cap * 3);
    this.posJourneyTarget = new Float32Array(this.cap * 3);
    this.morphDelay = new Float32Array(this.cap);
    this.morphLift = new Float32Array(this.cap);
    this.activity = new Float32Array(this.cap);
    this.ambient = new Float32Array(this.cap);
    this.reveal = new Float32Array(this.cap);
    this.tier = new Int8Array(this.cap).fill(2); // dormant spares pose as tier-2
    this.areaIndex = new Int32Array(this.cap).fill(-1);
    this.parentIndex = new Int32Array(this.cap).fill(-1);
    this.alwaysOn = new Uint8Array(this.cap);

    // each area's first milestone (graph order = order-sorted) stays revealed
    // at the overview - the R4 "first milestone ring"
    const firstSeen = new Set<string>();
    nodes.forEach((nd, i) => {
      if (nd.tier === 2 && nd.areaId && !firstSeen.has(nd.areaId)) {
        firstSeen.add(nd.areaId);
        this.alwaysOn[i] = 1;
      }
    });

    nodes.forEach((nd, i) => {
      this.index.set(nd.id, i);
      this.posBrain[i * 3] = nd.pos[0];
      this.posBrain[i * 3 + 1] = nd.pos[1];
      this.posBrain[i * 3 + 2] = nd.pos[2];
      this.tier[i] = nd.tier;
      this.ambient[i] = 0.06 + nd.baseEnergy * 0.12; // gentle resting glow
      this.activity[i] = this.ambient[i];
      this.reveal[i] = nd.tier <= 1 ? 1 : 0;
    });
    // per-node pulse/breath channels - MUST be allocated before the pass below
    // writes thinkPhase (a 2026-07-09 grey-window boot crash: the write ran while
    // these still lived after the edge-array allocs, i.e. on `undefined`).
    this.nodeArrival = new Float32Array(this.cap);
    this.nodeArrivalKind = new Float32Array(this.cap);
    this.thinkActive = new Float32Array(this.cap);
    this.thinkPhase = new Float32Array(this.cap);
    this._thinkRaw = new Float32Array(this.cap);
    // resolve parent / area indices (second pass - all ids known)
    nodes.forEach((nd, i) => {
      this.parentIndex[i] = nd.parentId ? this.index.get(nd.parentId) ?? -1 : -1;
      this.areaIndex[i] = nd.areaId ? this.index.get(nd.areaId) ?? -1 : -1;
      // stable thinking-breath phase. A tier-3 leaf copies its parent task's phase so
      // parent + children breathe in-unison (graph order guarantees the parent's phase
      // is already set - parents precede their children). Others get a deterministic
      // per-node phase so different tasks are staggered, not a screen-wide strobe.
      this.thinkPhase[i] =
        nd.tier >= 3 && this.parentIndex[i] >= 0
          ? this.thinkPhase[this.parentIndex[i]]
          : (Math.abs(Math.sin((i + 1) * 12.9898) * 43758.5453) % 1) * Math.PI * 2;
    });
    this.seedMorphShape();
    this.refreshJourneyTargets();
    this.posJourney.set(this.posJourneyTarget); // first layout lands exactly
    this.pos.set(this.posBrain); // start in brain layout

    // --- edges: structural graph + dependency-DAG journey links + sprout headroom ---
    // the tier-4 links ARE the journey dependency DAG (journey.ts journeyDagEdges):
    // the per-area spine + the authored cross-area deps (splits & merges). They
    // only render as the corridor forms (jm), so brain mode shows the structural
    // tree while journey mode shows the followable roadmap DAG.
    const milestones = usePraxisStore.getState().journey;
    const links: [number, number][] = [];
    for (const [aId, bId] of journeyDagEdges(milestones)) {
      const a = this.index.get(aId);
      const b = this.index.get(bId);
      if (a !== undefined && b !== undefined) links.push([a, b]);
    }

    this.edgeCount = edges.length + links.length;
    this.eCap = this.edgeCount + SPARE_EDGES;
    this.eA = new Int32Array(this.eCap);
    this.eB = new Int32Array(this.eCap);
    this.eTier = new Int8Array(this.eCap).fill(2); // dormant spares stay degenerate
    this.edgeActive = new Float32Array(this.eCap);
    this.edgePulseT = new Float32Array(this.eCap);
    this.edgePulseGlow = new Float32Array(this.eCap);
    this.edgePulseKind = new Float32Array(this.eCap);
    edges.forEach((e, i) => {
      const ai = this.index.get(e.a)!;
      const bi = this.index.get(e.b)!;
      this.eA[i] = ai;
      this.eB[i] = bi;
      this.eTier[i] = e.tier;
      this.edgeByChild.set(bi, i);
    });
    links.forEach(([a, b], k) => {
      const i = edges.length + k;
      this.eA[i] = a;
      this.eB[i] = b;
      this.eTier[i] = 4; // story-link: only visible as the corridor forms
    });

    // precompute hub→node edge chains
    for (let i = 0; i < this.n; i++) {
      if (this.tier[i] === 0) continue;
      const chain: number[] = [];
      let cur = i;
      let guard = 0;
      while (cur !== -1 && this.tier[cur] !== 0 && guard++ < 8) {
        const e = this.edgeByChild.get(cur);
        if (e === undefined) break;
        chain.unshift(e);
        cur = this.parentIndex[cur];
      }
      this.chainOf.set(i, chain);
    }

    // agents start drifting near the hub
    let peripheralRank = 0;
    this.agents = this.g.agents.map((a, k) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      infra: !!a.infra,
      model: undefined,
      modelCol: null,
      pos: new THREE.Vector3(
        Math.cos((k / this.g.agents.length) * Math.PI * 2) * 5,
        Math.sin(k * 1.7) * 2,
        Math.sin((k / this.g.agents.length) * Math.PI * 2) * 5,
      ),
      anchor: new THREE.Vector3(),
      attachTask: -1,
      attachArea: -1,
      real: false,
      intensity: 0.25,
      targetIntensity: 0.25,
      phase: k * 1.3,
      fireTimer: 0,
      dockSlot: k,
      dockRank: a.infra ? -1 : peripheralRank++,
      trail: new Float32Array(TRAIL_LEN * 3),
      trailHead: 0,
      transit: -1,
      transitFrom: new THREE.Vector3(),
      transitDur: 1.2,
      transitEdges: [],
    }));
    this.peripheralCount = peripheralRank;
    // seed trails at the start position
    for (const ag of this.agents) {
      for (let t = 0; t < TRAIL_LEN; t++) {
        ag.trail[t * 3] = ag.pos.x;
        ag.trail[t * 3 + 1] = ag.pos.y;
        ag.trail[t * 3 + 2] = ag.pos.z;
      }
    }

    this.unsub = eventBus.subscribe((e) => this.onEvent(e));
    this.pushCapacityToStore();
  }

  dispose() {
    this.unsub?.();
  }

  // -------------------------------------------------------------------------
  // Journey morph - ONE canvas, two layouts (spec §A.4)
  // -------------------------------------------------------------------------

  /** Deterministic per-node stagger + transit arc, for the unfurl feel. */
  private seedMorphShape() {
    const areaRank = new Map<string, number>();
    this.nodes.forEach((nd) => {
      if (nd.tier === 1 && !areaRank.has(nd.id)) areaRank.set(nd.id, areaRank.size);
    });
    // per-area running task index
    const taskRank = new Map<string, number>();
    const taskCounter = new Map<string, number>();
    for (const nd of this.nodes) {
      if (nd.tier !== 2 || !nd.areaId) continue;
      const c = taskCounter.get(nd.areaId) ?? 0;
      taskRank.set(nd.id, c);
      taskCounter.set(nd.areaId, c + 1);
    }
    this.nodes.forEach((nd, i) => {
      const ar = areaRank.get(nd.areaId ?? "") ?? 0;
      let d = 0;
      if (nd.tier === 1) d = 0.04 + ar * 0.022;
      else if (nd.tier === 2) d = 0.12 + ar * 0.03 + (taskRank.get(nd.id) ?? 0) * 0.012;
      else if (nd.tier === 3) d = 0.2 + ar * 0.03 + 0.06;
      this.morphDelay[i] = Math.min(d, MORPH_STAGGER);
      const h = hash01(nd.id);
      this.morphLift[i] =
        (h - 0.5) * 2 * (nd.tier === 2 ? 3.4 : nd.tier === 3 ? 1.9 : nd.tier === 1 ? 2.4 : 0);
    });
  }

  /**
   * Recompute corridor targets from the CURRENT journey model (also on sprout).
   * Writes TARGETS only - update() eases posJourney toward them, so a sprout
   * that re-slots visible siblings flows them to their new spot, no teleport.
   */
  refreshJourneyTargets() {
    const milestones = usePraxisStore.getState().journey;
    const targets = computeJourneyTargets(this.g, milestones);
    for (let i = 0; i < this.n; i++) {
      const t = targets.get(this.nodes[i]?.id ?? "");
      if (t) {
        this.posJourneyTarget[i * 3] = t[0];
        this.posJourneyTarget[i * 3 + 1] = t[1];
        this.posJourneyTarget[i * 3 + 2] = t[2];
      } else {
        this.posJourneyTarget[i * 3] = this.posBrain[i * 3];
        this.posJourneyTarget[i * 3 + 1] = this.posBrain[i * 3 + 1];
        this.posJourneyTarget[i * 3 + 2] = this.posBrain[i * 3 + 2];
      }
    }
    this.journeySettled = false;
  }

  /**
   * Drive the brain⇄journey morph (t: 0=brain → 1=journey). Called from a GSAP
   * tween with a LINEAR ease - each node applies its own smootherstep inside its
   * stagger window, which is what produces the flowing unfurl. Transforms only.
   */
  setMorph(t: number) {
    this.morph = t;
    const span = 1 + MORPH_STAGGER;
    for (let i = 0; i < this.n; i++) {
      let p = t * span - this.morphDelay[i];
      p = p < 0 ? 0 : p > 1 ? 1 : p;
      const e = p * p * p * (p * (p * 6 - 15) + 10); // smootherstep
      const arc = Math.sin(p * Math.PI) * this.morphLift[i];
      const j = i * 3;
      this.pos[j] = this.posBrain[j] + (this.posJourney[j] - this.posBrain[j]) * e;
      this.pos[j + 1] =
        this.posBrain[j + 1] + (this.posJourney[j + 1] - this.posBrain[j + 1]) * e + arc;
      this.pos[j + 2] = this.posBrain[j + 2] + (this.posJourney[j + 2] - this.posBrain[j + 2]) * e;
    }
  }

  /** Sprout slots left this session (each needs 1 node + up to 2 edges). */
  sproutSlotsLeft(): number {
    return Math.max(
      0,
      Math.min(this.cap - this.n, Math.floor((this.eCap - this.edgeCount) / 2)),
    );
  }

  private pushCapacityToStore() {
    usePraxisStore.setState({ sproutSlotsLeft: this.sproutSlotsLeft() });
  }

  /** Activate a preallocated slot for a brain-dump milestone (spec §B.2). */
  private activateSprout(e: PraxisEvent) {
    const id = e.nodeId;
    if (!id || this.index.has(id)) return;
    const nd = this.g.byId.get(id);
    if (!nd) return;
    if (this.n >= this.cap || this.edgeCount + 2 > this.eCap) {
      if (import.meta.env.DEV) console.warn("[praxis] sprout capacity exhausted — node not visualized");
      return;
    }

    const i = this.n++;
    this.index.set(id, i);
    this.tier[i] = 2;
    const ai = this.areaIndex[i] = nd.areaId ? this.index.get(nd.areaId) ?? -1 : -1;
    this.parentIndex[i] = ai;
    this.posBrain[i * 3] = nd.pos[0];
    this.posBrain[i * 3 + 1] = nd.pos[1];
    this.posBrain[i * 3 + 2] = nd.pos[2];
    this.ambient[i] = 0.06 + nd.baseEnergy * 0.12;
    this.activity[i] = this.ambient[i];
    this.reveal[i] = 0; // grows in via the LOD ease - the sprout moment
    // sprouts are tier-2 tasks → own deterministic breath phase
    this.thinkPhase[i] = (Math.abs(Math.sin((i + 1) * 12.9898) * 43758.5453) % 1) * Math.PI * 2;
    // stagger/lift for future morphs
    this.morphDelay[i] = Math.min(0.16 + (hash01(id) % 0.1), MORPH_STAGGER);
    this.morphLift[i] = (hash01(id + "~lift") - 0.5) * 2 * 3.4;

    // wire: area → sprout (structural), prev milestone → sprout (story link)
    if (ai >= 0) {
      const ei = this.edgeCount++;
      this.eA[ei] = ai;
      this.eB[ei] = i;
      this.eTier[ei] = 2;
      this.edgeByChild.set(i, ei);
      this.chainOf.set(i, [...(this.chainOf.get(ai) ?? []), ei]);
    }
    const prevIdx = e.taskId ? this.index.get(e.taskId) : undefined;
    if (prevIdx !== undefined) {
      const ej = this.edgeCount++;
      this.eA[ej] = prevIdx;
      this.eB[ej] = i;
      this.eTier[ej] = 4;
      // if prev already linked to a successor, re-point that link THROUGH the
      // sprout (prev → sprout → next) so the story river doesn't fork
      const nextIdx = e.nextId ? this.index.get(e.nextId) : undefined;
      if (nextIdx !== undefined) {
        for (let k = 0; k < this.edgeCount; k++) {
          if (this.eTier[k] === 4 && this.eA[k] === prevIdx && this.eB[k] === nextIdx) {
            this.eA[k] = i;
            break;
          }
        }
      }
    }

    this.refreshJourneyTargets();
    // the NEW node lands on its slot exactly (siblings ease; it sprouts in place)
    this.posJourney[i * 3] = this.posJourneyTarget[i * 3];
    this.posJourney[i * 3 + 1] = this.posJourneyTarget[i * 3 + 1];
    this.posJourney[i * 3 + 2] = this.posJourneyTarget[i * 3 + 2];
    this.setMorph(this.morph); // place it in the current blend immediately
    this.fireChain(i, 1.35); // celebration pulse down the new branch
    this.pushCapacityToStore();
  }

  /**
   * Frame-guarded tick. Every brain component calls this at the top of its useFrame,
   * so whichever runs first advances the timeline + integrates state once; the rest
   * read fresh arrays. Order-independent, single source of time.
   */
  tick(state: RootState) {
    const elapsed = state.clock.elapsedTime;
    if (elapsed === this.lastElapsed) return;
    const dt = this.lastElapsed < 0 ? 1 / 60 : Math.min(0.05, elapsed - this.lastElapsed);
    this.lastElapsed = elapsed;

    const paused = usePraxisStore.getState().paused;
    if (!paused && this.mockEnabled) {
      this.playClock += dt;
      this.player.update(this.playClock);
    }

    state.camera.getWorldPosition(this._camWorld);
    // camera right/up columns → the plane working agents orbit in (billboard orbit)
    this._camRight.setFromMatrixColumn(state.camera.matrixWorld, 0).normalize();
    this._camUp.setFromMatrixColumn(state.camera.matrixWorld, 1).normalize();
    this.update(dt, elapsed, this._camWorld);
  }

  private agentById(id?: string): AgentRT | undefined {
    if (!id) return undefined;
    return this.agents.find((a) => a.id === id);
  }

  private bump(nodeIdx: number, amount: number) {
    this.activity[nodeIdx] = Math.min(1.6, this.activity[nodeIdx] + amount);
  }

  /** Fire one routed pulse down each chain edge in sequence. */
  fireChain(targetIdx: number, strength: number, kind = 0) {
    const chain = this.chainOf.get(targetIdx);
    if (!chain) return;
    // A pulse must END on a VISIBLE node. Real work force-reveals its node (spec A.2), so
    // genuinely-worked targets still receive the full chain once their reveal ramps in.
    let end = chain.length;
    while (end > 0) {
      const dst = this.eB[chain[end - 1]];
      if (this.reveal[dst] > 0.35 || this.alwaysOn[dst] > 0) break;
      end -= 1;
    }
    if (end === 0) return; // nothing visible along this path - no orphan light
    let delay = 0;
    for (let c = 0; c < end; c++) {
      const e = chain[c];
      const speed = kind === 1 ? 0.28 + Math.random() * 0.14 : 0.55 + Math.random() * 0.4;
      this.spawnPulse(e, speed, strength * (0.7 + 0.3 * Math.random()), kind, delay);
      delay += 0.88 / speed;
    }
  }

  spawnPulse(edgeIdx: number, speed: number, intensity: number, kind = 0, delay = 0) {
    const i = this.pHead;
    this.pHead = (this.pHead + 1) % PULSE_MAX;
    this.pEdge[i] = edgeIdx;
    this.pProg[i] = 0;
    this.pSpeed[i] = speed;
    this.pIntensity[i] = intensity;
    this.pSeed[i] = Math.random() * Math.PI * 2;
    this.pKind[i] = kind;
    this.pDelay[i] = Math.max(0, delay);
    this.pBright[i] = 0;
  }

  /**
   * Begin a ROUTED transit for an agent newly assigned to task `ti`: it flies in to its cluster
   * medallion, then rides the structural branch out to the task.
   */
  private beginTransit(ag: AgentRT, ti: number) {
    ag.transit = 0;
    ag.transitFrom.copy(ag.pos);
    ag.transitDur = 1.0 + Math.random() * 0.5;
    const chain = this.chainOf.get(ti);
    // chainOf is hub→…→task; drop the hub→area trunk so we ride area→task (the
    // agent flies straight to the medallion, then out its own branch)
    ag.transitEdges = chain && chain.length > 1 ? chain.slice(1) : chain ?? [];
    ag.fireTimer = 0; // light the path immediately as it sets off
  }

  /** World position along an agent's travel route at progress `prog` (0..1). */
  private routePoint(ag: AgentRT, prog: number, out: Float32Array) {
    const ti = ag.attachTask;
    if (ti < 0) {
      out[0] = ag.pos.x;
      out[1] = ag.pos.y;
      out[2] = ag.pos.z;
      return;
    }
    const areaIdx = ag.attachArea >= 0 ? ag.attachArea : this.areaIndex[ti];
    const noBranch = areaIdx < 0 || ag.transitEdges.length === 0;
    if (prog < TRANSIT_LEAD || noBranch) {
      // lead-in: launch position → cluster medallion (a gentle arc toward camera)
      const tgt = noBranch ? ti : areaIdx;
      const tx = this.pos[tgt * 3];
      const ty = this.pos[tgt * 3 + 1];
      const tz = this.pos[tgt * 3 + 2];
      const lp = noBranch ? prog : prog / TRANSIT_LEAD; // 0..1 across the lead-in
      const e = lp * lp * (3 - 2 * lp); // smoothstep
      const lift = Math.sin(lp * Math.PI) * 1.6; // bow up + toward camera
      out[0] = ag.transitFrom.x + (tx - ag.transitFrom.x) * e;
      out[1] = ag.transitFrom.y + (ty - ag.transitFrom.y) * e;
      out[2] = ag.transitFrom.z + (tz - ag.transitFrom.z) * e + lift;
      return;
    }
    // ride the area→task edge chain (the agent's own branch)
    const edges = ag.transitEdges;
    const local = (prog - TRANSIT_LEAD) / (1 - TRANSIT_LEAD); // 0..1 across the chain
    const seg = Math.min(edges.length - 1, Math.floor(local * edges.length));
    const segT = local * edges.length - seg;
    const ed = edges[seg];
    const a = this.eA[ed];
    const b = this.eB[ed];
    const ax = this.pos[a * 3];
    const ay = this.pos[a * 3 + 1];
    const az = this.pos[a * 3 + 2];
    const bx = this.pos[b * 3];
    const by = this.pos[b * 3 + 1];
    const bz = this.pos[b * 3 + 2];
    edgeControlPoints(ax, ay, az, bx, by, bz, this.eTier[ed], this._c1, this._c2, this.morph);
    cubicBezierPoint(
      ax, ay, az,
      this._c1[0], this._c1[1], this._c1[2],
      this._c2[0], this._c2[1], this._c2[2],
      bx, by, bz, segT, out,
    );
  }

  /** Launch an information packet from agent `fromIdx` to agent `toIdx`. */
  spawnHandoff(fromIdx: number, toIdx: number, intensity: number) {
    const i = this.hHead;
    this.hHead = (this.hHead + 1) % HANDOFF_MAX;
    this.hFrom[i] = fromIdx;
    this.hTo[i] = toIdx;
    this.hProg[i] = 0;
    this.hSpeed[i] = 0.5 + Math.random() * 0.18; // ~1.5–2s arc
    this.hIntensity[i] = intensity;
  }

  /** Launch a roadmap packet from milestone node `fromNode` to milestone `toNode`
   *  (journey:handoff). Slower + larger than an agent packet - it's the WORK
   *  advancing along the plan, not a quick word between two agents. */
  spawnJourneyHandoff(fromNode: number, toNode: number, intensity: number) {
    const i = this.mHead;
    this.mHead = (this.mHead + 1) % MHANDOFF_MAX;
    this.mFrom[i] = fromNode;
    this.mTo[i] = toNode;
    this.mProg[i] = 0;
    this.mSpeed[i] = 0.34 + Math.random() * 0.12; // ~2.3–3s flow down the corridor
    this.mIntensity[i] = intensity;
  }

  /** Resolve an event to a node index, falling back nodeId → taskId → areaId so a
   *  real file (synthetic id, no mock node) still pulses its area branch. */
  private resolveTarget(e: PraxisEvent): number | undefined {
    for (const id of [e.nodeId, e.taskId, e.areaId]) {
      if (id) {
        const i = this.index.get(id);
        if (i !== undefined) return i;
      }
    }
    return undefined;
  }

  private onEvent(e: PraxisEvent) {
    const targetIdx = this.resolveTarget(e);

    switch (e.type) {
      case "agent:status": {
        const ag = this.agentById(e.agentId);
        if (!ag) break;
        // INFRA agents (Hermes brain engine + Relay/Ledger) are the invisible engine,
        // NOT peripheral orbiting workers. Their activity is represented AT THE CORE:
        // "working" flutters the nucleus (talk) and lights the touched area's branch,
        // but they never attach/orbit a task or leave the dock. Keep intensity low so
        // no downstream (e.g. handoff) reads them as a bright chip.
        if (ag.infra) {
          if (e.status === "working") {
            this.talk = Math.min(1, this.talk + 0.3); // the engine thinks → core flutter
            if (targetIdx !== undefined) this.fireChain(targetIdx, 0.55);
          }
          ag.attachTask = -1;
          ag.attachArea = -1;
          ag.real = false;
          ag.transit = -1;
          ag.targetIntensity = 0.2;
          if (e.model && e.model !== ag.model) {
            ag.model = e.model;
            const hex = modelTint(e.model);
            ag.modelCol = hex ? new THREE.Color(hex) : null;
          }
          break;
        }
        if (e.status === "working" && e.taskId) {
          const ti = this.index.get(e.taskId) ?? -1;
          const isNewTask = ti !== ag.attachTask;
          ag.attachTask = ti;
          ag.attachArea = e.areaId
            ? this.index.get(e.areaId) ?? -1
            : ti >= 0
              ? this.areaIndex[ti]
              : -1;
          // real ⇔ this attach came from the real-event bridge (Tauri session /
          // Hermes push), not the mock's scripted filler (spec A.2).
          ag.real = !this.mockTick;
          ag.targetIntensity = 1;
          // identity-by-model: remember which model drives this agent + cache its
          // signature colour (only on change - no per-event Color allocation)
          if (e.model && e.model !== ag.model) {
            ag.model = e.model;
            const hex = modelTint(e.model);
            ag.modelCol = hex ? new THREE.Color(hex) : null;
          }
          if (isNewTask && ti >= 0) this.beginTransit(ag, ti);
        } else if (e.status === "done") {
          ag.targetIntensity = 0.6; // linger, dimmer, at the finished task
        } else if (e.status === "idle") {
          ag.attachTask = -1;
          ag.attachArea = -1;
          ag.real = false;
          ag.targetIntensity = 0.22;
          ag.transit = -1; // cancel any in-flight route; it heads to the dock
        }
        break;
      }
      case "agent:handoff": {
        const from = this.agents.findIndex((a) => a.id === e.agentId);
        const to = this.agents.findIndex((a) => a.id === e.toAgentId);
        if (from >= 0 && to >= 0 && from !== to) {
          // a packet only flows between two VISIBLE chips; if either end is an infra
          // agent (no chip), the exchange still registers as a core flutter but draws
          // no periph-to-periph packet arcing to/from empty space.
          if (!this.agents[from].infra && !this.agents[to].infra) this.spawnHandoff(from, to, 1);
          this.talk = Math.min(1, this.talk + 0.22); // the core registers the exchange
        }
        break;
      }
      case "journey:handoff": {
        // work flows along the roadmap from one milestone to the next it feeds
        const from = e.taskId ? this.index.get(e.taskId) : undefined;
        const to = e.nextId ? this.index.get(e.nextId) : undefined;
        if (from !== undefined && to !== undefined && from !== to) {
          this.spawnJourneyHandoff(from, to, 1);
          this.nodeArrival[from] = Math.max(this.nodeArrival[from], 0.55);
          this.nodeArrivalKind[from] = 1;
        }
        break;
      }
      case "agent:thinking": {
        if (targetIdx !== undefined) this.fireChain(targetIdx, 0.7);
        this.talk = Math.min(1, this.talk + 0.4); // the core flutters as it thinks
        break;
      }
      case "task:start": {
        if (targetIdx !== undefined) this.fireChain(targetIdx, 1.1);
        break;
      }
      case "task:progress": {
        if (targetIdx !== undefined) this.fireChain(targetIdx, 0.5 + (e.progress ?? 0) * 0.6);
        break;
      }
      case "task:complete": {
        if (targetIdx !== undefined) {
          this.fireChain(targetIdx, 1.4);
        }
        break;
      }
      case "memory:updated": {
        // a clearly DIFFERENT motif: a slow cool packet gliding to the node
        if (targetIdx !== undefined) {
          this.fireChain(targetIdx, 1.0, 1);
        }
        break;
      }
      case "file:created": {
        if (targetIdx !== undefined) {
          this.fireChain(targetIdx, 1.0);
        }
        break;
      }
      case "orchestrator:speaking": {
        // the core "speaks" - start (or extend) the voice envelope window
        this.speakRemaining = Math.max(this.speakRemaining, e.duration ?? 1.6);
        this.talk = Math.min(1, this.talk + 0.3);
        break;
      }
      case "journey:sprout": {
        this.activateSprout(e);
        break;
      }
      case "journey:status": {
        // A milestone's plan status changed from REAL work (spec §B.4). The store's
        // applyEvent has already patched store.journey + the live graph node status;
        // re-slot the time-corridor so the milestone flows to its new past/now/future
        // position. Deferred to a microtask so the store's synchronous set() (which
        // runs in a SEPARATE bus subscriber) has landed before we re-read journey -
        // this handler must not depend on subscriber ordering.
        queueMicrotask(() => this.refreshJourneyTargets());
        break;
      }
    }
  }

  /** Advance all state. `camPos` drives LOD reveal. */
  update(dt: number, _elapsed: number, camPos: THREE.Vector3) {
    const d = Math.min(dt, 0.05); // clamp for stability on hitches

    // --- corridor re-slots ease toward their targets (sprout reflow) ---
    if (!this.journeySettled) {
      const k = 1 - Math.exp(-5 * d);
      let maxSq = 0;
      for (let i = 0; i < this.n * 3; i++) {
        const diff = this.posJourneyTarget[i] - this.posJourney[i];
        this.posJourney[i] += diff * k;
        if (diff * diff > maxSq) maxSq = diff * diff;
      }
      if (maxSq < 1e-6) {
        this.posJourney.set(this.posJourneyTarget.subarray(0, this.n * 3));
        this.journeySettled = true;
      }
      this.setMorph(this.morph); // re-blend pos from the moving layout
    }

    // --- node glow decay toward ambient + arrival-flash decay ---
    // arrival flash falls off with a ~0.6s natural tail (exp(-4.6·d)) so a landed
    // pulse blooms the node then fades, never lingering.
    const arrivalDecay = Math.exp(-4.6 * d);
    for (let i = 0; i < this.n; i++) {
      const amb = this.ambient[i];
      const a = this.activity[i];
      this.activity[i] = amb + (a - amb) * Math.exp(-1.8 * d);
      if (this.nodeArrival[i] > 0.0004) this.nodeArrival[i] *= arrivalDecay;
      else this.nodeArrival[i] = 0;
    }
    // --- core signals: busyness (mean area activity) + talk flutter decay ---
    {
      let busy = 0;
      let c = 0;
      for (let i = 0; i < this.n; i++) {
        if (this.tier[i] === 1) {
          busy += this.activity[i];
          c++;
        }
      }
      this.busy = c ? busy / c : 0;
      this.talk *= Math.exp(-2.4 * d);
    }
    // --- voice envelope (Praxis speech ripple) ---
    // The core ripples WITH the words. When a real TTS clip is playing, the tap
    // in voice/micLevel.ts hands us the ACTUAL audio amplitude - the nucleus
    // moves in sync with the voice, word for word. The layered-sine cadence
    // remains the fallback (SpeechSynthesis path has no tappable element).
    const liveTts = getTtsLevel();
    if (liveTts > 0.015) {
      this.speakRemaining = Math.max(this.speakRemaining, 0.15); // audio is live
      const target = 0.22 + 0.78 * Math.min(1, liveTts * 1.25);
      this.voice += (target - this.voice) * (1 - Math.exp(-22 * d));
    } else if (this.speakRemaining > 0) {
      this.speakRemaining = Math.max(0, this.speakRemaining - d);
      const tt = _elapsed;
      const syl = Math.sin(tt * 9.2) * Math.sin(tt * 3.1 + 1.3); // beat × cadence
      const target = 0.32 + 0.68 * (0.5 + 0.5 * syl); // ~0.32..1, lively, never silent
      this.voice += (target - this.voice) * (1 - Math.exp(-15 * d));
    } else {
      this.voice += (0 - this.voice) * (1 - Math.exp(-6 * d)); // fade out cleanly
    }
    this.talk = Math.max(this.talk, this.voice * 0.85); // the nucleus flutters as it speaks
    // --- edge glow decay ---
    for (let e = 0; e < this.edgeCount; e++) {
      this.edgeActive[e] *= Math.exp(-1.4 * d);
    }

    // --- LOD reveal from camera distance ---
    // Brain mode gates tasks on their AREA's distance (fly toward a lobe, its
    // work blooms). Journey mode gates each task on ITS OWN distance, so the
    // corridor fades at the far ends - the same revealBand mechanic, re-aimed.
    this._cam.copy(camPos);
    const jm = this.morph;
    // which CLUSTER is currently focused (its detail leaves bloom to labelled, so
    // a focused cluster reads populated; null at the overview → leaves stay twigs)
    const focusId = usePraxisStore.getState().focusId;
    let focusedArea = -1;
    let focusedNode = -1;
    if (focusId) {
      const fi = this.index.get(focusId);
      if (fi !== undefined) {
        focusedNode = fi;
        focusedArea = this.tier[fi] === 1 ? fi : this.areaIndex[fi];
      }
    }
    // tasks a REAL agent is currently orbiting → force them fully revealed (node + label)
    // at ANY zoom, so an agent is never seen orbiting "empty space" (spec A.2: node
    // always-visible + orbit ONLY when a real agent's live status is "working" AND it's
    // assigned to that node AND the node's cluster is active). Mock-filler attachments
    // (ag.real === false) never force a node visible - idle stays honestly calm.
    const agentTasks = new Set<number>();
    for (const ag of this.agents) {
      // infra agents render no chip/orbit, so they never force a node always-visible.
      if (ag.infra || !ag.real || ag.attachTask < 0 || ag.attachTask >= this.n) continue;
      // A task a REAL agent is actively working is force-revealed at any zoom (spec
      // A.2 - never orbit empty space). This used to be additionally gated on the
      // cluster's INSTANTANEOUS activity (> ambient·1.1); because that value spikes on
      // each fire-heartbeat then decays between beats, the gate flickered on/off ~every
      // second - which chaotically toggled the task's reveal and made it "disappear and
      // reappear" only for some nodes (whichever clusters happened to hover near the
      // threshold). That was the ROOT CAUSE of the inconsistent "thinking" effect. The
      // breath is now an explicit, uniform render effect (thinkActive/thinkPhase), so
      // this gate is stable: a worked task simply stays revealed.
      agentTasks.add(ag.attachTask);
    }

    for (let i = 0; i < this.n; i++) {
      const tr = this.tier[i];
      let target: number;
      if (tr <= 1) {
        target = 1;
      } else if (tr === 2) {
        // planar map: AREA-FOCUS framings sit ~36-42 from their area node and the
        // overview ~62+, so the band separates the two compositions. NB: tier-2 is now
        // purely ZOOM-gated (no per-area always-on first-milestone) so a whole level
        // reveals together - never "some tasks show, others don't" at the same zoom.
        const brainT = revealBand(this.distToNode(this.areaIndex[i]), 44, 60);
        // journey roadmap: reveal ALL milestones (the whole DAG is the map), so
        // every task carries its label + ETA. The done-recede below still dims
        // ancient work; the band is wide enough that nothing drops out by distance.
        // roadmap: every milestone in the lane is part of the readable map (the
        // left-aligned columns already place done work at the left, future at the
        // right), so reveal the whole lane - completed work reads "behind" by its
        // status colour + plan tag, not by fading out of the diagram.
        // Every milestone is structural content in Journey, including the outer
        // history/future tips. A distance band made those exact nodes disappear
        // when the camera pulled back far enough to fit the full roadmap.
        const journeyT = jm > 0.001 ? 1 : 0;
        target = brainT + (journeyT - brainT) * jm;
      } else {
        // tier-3 DETAIL LEAVES. They bloom fully as you near their task, but
        // also carry an overview FLOOR tied to the parent task's own reveal - so
        // every branch that's visible ends in leaf-twigs (IMG_1231) instead of
        // bare nothing, while a hidden branch grows none (no detached leaves).
        // The parent (lower index) was integrated earlier this frame, so its
        // reveal is fresh. Capped below the 0.7 label gate (Labels.tsx) so the
        // leaf TEXT stays off at the overview - they're unlabeled twigs there.
        const pi = this.parentIndex[i];
        const ai = this.areaIndex[i];
        const near = revealBand(this.distToNode(pi), 9, 18);
        // overview FLOOR: visible as an UNLABELLED twig (< the 0.7 label gate) so
        // every shown branch ends in leaves but the overview stays calm
        const parentFloor = Math.min(this.reveal[pi] * 0.9, 0.6);
        // FOCUS bloom: when THIS cluster is the focused one, its whole leaf set
        // reveals + labels, so a focused cluster reads POPULATED, not empty dots
        // (brain mode only - journey has its own depth rules)
        const focusBloom = jm < 0.5 && ai === focusedArea ? 0.95 : 0;
        // journey: focusing a milestone blooms ITS artifacts to labelled, so
        // "zoom into a task" actually surfaces its files/docs/memories - the
        // final detail layer (otherwise the comb stays unlabelled twigs).
        const focusBloomJourney = jm > 0.5 && pi === focusedNode ? 0.97 : 0;
        target = Math.max(near, parentFloor, focusBloom, focusBloomJourney);
      }
      // a task being orbited by an agent is ALWAYS revealed (overrides LOD) - Fix: the agent
      // must visibly orbit a real, on-screen task at any zoom.
      if (agentTasks.has(i)) target = 1;
      // ease reveal so it fades rather than snaps
      this.reveal[i] += (target - this.reveal[i]) * (1 - Math.exp(-6 * d));
    }

    // --- standardized "thinking" active gate ---
    // R3/R4 lock: nodes must not light or breathe independently of routed pathways.
    // Keep the channel alive for the renderer contract, but decay it to zero; real
    // visual energy is now carried by edge pulses -> nodeArrival.
    const thinkEase = 1 - Math.exp(-2.5 * d);
    for (let i = 0; i < this.n; i++) {
      const raw = 0;
      this._thinkRaw[i] = raw;
      this.thinkActive[i] += (raw - this.thinkActive[i]) * thinkEase;
    }

    // --- pulses ---
    // reset the per-edge pulse aggregate; the loop below re-fills it for every edge
    // that currently carries a live pulse, so the tube can locally light its path.
    this.edgePulseGlow.fill(0, 0, this.edgeCount);
    for (let i = 0; i < PULSE_MAX; i++) {
      if (this.pIntensity[i] <= 0.001) {
        this.pBright[i] = 0;
        continue;
      }
      if (this.pDelay[i] > 0) {
        this.pDelay[i] = Math.max(0, this.pDelay[i] - d);
        this.pBright[i] = 0;
        continue;
      }
      let prog = this.pProg[i] + this.pSpeed[i] * d;
      const e = this.pEdge[i];
      if (e >= 0 && e < this.edgeCount) {
        this.edgeActive[e] = Math.max(this.edgeActive[e], Math.min(1.4, this.pIntensity[i]));
      }
      if (prog >= 1) {
        // arrival flash on the child node - the travelling light LANDS: a small
        // activity bump (feeds the generic glow) PLUS a dedicated comet-energy bloom
        // in the pulse's own colour family, so the destination node "lights up in the
        // same manner at the end of it". The arrival channel decays on its own (below).
        const bi = this.eB[e];
        this.bump(bi, 0.12 * this.pIntensity[i]);
        if (bi >= 0 && bi < this.n) {
          const e2 = Math.min(1, this.pIntensity[i]);
          if (e2 > this.nodeArrival[bi]) {
            this.nodeArrival[bi] = e2;
            this.nodeArrivalKind[bi] = this.pKind[i];
          }
        }
        this.pIntensity[i] = 0;
        this.pBright[i] = 0;
        continue;
      }
      this.pProg[i] = prog;
      const ai = this.eA[e];
      const bi = this.eB[e];
      const ax = this.pos[ai * 3];
      const ay = this.pos[ai * 3 + 1];
      const az = this.pos[ai * 3 + 2];
      const bx = this.pos[bi * 3];
      const by = this.pos[bi * 3 + 1];
      const bz = this.pos[bi * 3 + 2];
      // ride the SAME routed cubic Bézier as the tube + flow beads, so the pulse
      // sits exactly on the path (was a straight lerp + seeded perpendicular arc
      // that floated the pulse off the visible tube).
      const tier = this.eTier[e];
      edgeControlPoints(ax, ay, az, bx, by, bz, tier, this._c1, this._c2, this.morph);
      cubicBezierPoint(
        ax, ay, az,
        this._c1[0], this._c1[1], this._c1[2],
        this._c2[0], this._c2[1], this._c2[2],
        bx, by, bz, prog, this._routePos,
      );
      this.pPos[i * 3] = this._routePos[0];
      this.pPos[i * 3 + 1] = this._routePos[1];
      this.pPos[i * 3 + 2] = this._routePos[2];
      const pb = this.pIntensity[i] * Math.sin(prog * Math.PI);
      this.pBright[i] = pb;
      // record the brightest pulse riding this edge so the tube shader can light
      // the segment under it (the "lights illuminate their pathway" fix)
      if (e >= 0 && e < this.edgeCount && pb > this.edgePulseGlow[e]) {
        this.edgePulseGlow[e] = pb;
        this.edgePulseT[e] = prog;
        this.edgePulseKind[e] = this.pKind[i];
      }
    }

    // --- agents ---
    for (const ag of this.agents) {
      ag.phase += d * 1.6;
      ag.intensity += (ag.targetIntensity - ag.intensity) * (1 - Math.exp(-4 * d));

      let moveStiff = 3.2;
      // Movement/orbit only follows a REAL attach (spec A.2) - a mock-filler
      // attachment (ag.real === false) is treated as idle here so the chip docks
      // calmly instead of visibly travelling to / orbiting a fabricated task.
      const hasRealWork = ag.attachTask >= 0 && ag.real;
      const transiting = ag.transit >= 0 && ag.transit < 1 && hasRealWork;

      if (transiting) {
        // TRAVEL: fly in to the cluster medallion, then ride the branch out to
        // the task - the agent visibly journeys the connectome to its work, so
        // "which cluster is it on" reads at a glance (spec §2).
        ag.transit = Math.min(1, ag.transit + d / ag.transitDur);
        this.routePoint(ag, ag.transit, this._routeOut);
        ag.anchor.set(this._routeOut[0], this._routeOut[1], this._routeOut[2]);
        moveStiff = 11; // track the curve tightly so the comet rides the path
        // the branch lights up UNDER the traveller (it carries the work to it)
        ag.fireTimer -= d;
        if (ag.fireTimer <= 0) {
          this.fireChain(ag.attachTask, 0.42 * Math.max(0.45, ag.intensity));
          ag.fireTimer = 0.42 + Math.random() * 0.3;
        }
        if (ag.transit >= 1) {
          ag.transit = -1; // arrived → settle into orbit/dock-beside
          ag.fireTimer = 0.6;
        }
      } else if (hasRealWork) {
        const ti = ag.attachTask;
        this._a.set(this.pos[ti * 3], this.pos[ti * 3 + 1], this.pos[ti * 3 + 2]);
        if (this.morph > 0.5) {
          // JOURNEY: DOCK the chip on the lane just left of + slightly below its
          // milestone - "on site" without orbiting on top of the node and its
          // label (the comb of artifacts hangs to the RIGHT, so the left is clear).
          const bob = Math.sin(ag.phase * 0.6) * 0.12;
          ag.anchor.set(this._a.x - 2.5, this._a.y - 1.9 + bob, this._a.z + 0.6);
        } else {
          // BRAIN: ORBIT the task in the CAMERA'S VIEW PLANE - a true billboard circle
          // (cos·right + sin·up), so it always reads as a clean ring around the node from
          // any angle, never edge-on "back and forth". Tight follow so it traces the ring.
          const r = 2.2;
          const c = Math.cos(ag.phase) * r;
          const s = Math.sin(ag.phase) * r;
          ag.anchor.set(
            this._a.x + this._camRight.x * c + this._camUp.x * s,
            this._a.y + this._camRight.y * c + this._camUp.y * s,
            this._a.z + this._camRight.z * c + this._camUp.z * s,
          );
          moveStiff = 9;
        }
        // sparse heartbeat while it works - real events (thinking/progress)
        // carry the firing now; flickers carry the "alive" feel (design lock §3:
        // every pulse means something, kill the continuous stream)
        ag.fireTimer -= d;
        if (ag.fireTimer <= 0) {
          this.fireChain(ti, 0.35 * ag.intensity);
          ag.fireTimer = 1.1 + Math.random() * 0.8;
        }
      } else {
        // idle: DOCK in a neat dim arc below the core (its south pole), a stable
        // slot per agent - never a wandering "flying light" (spec: idle = docked).
        // Only PERIPHERAL (non-infra) agents get a chip, so the dock arc is spread
        // over their count/rank - infra agents (Hermes/Relay/Ledger) never sit in the
        // bay, so their absence can't punch gaps into the visible arc.
        const n = this.peripheralCount;
        const spread = 1.6; // radians the dock arc subtends
        const ang = -Math.PI / 2 + (ag.dockRank / Math.max(1, n - 1) - 0.5) * spread;
        const dockR = 12.2;
        const bob = Math.sin(ag.phase * 0.5 + ag.dockSlot) * 0.25; // faint life only
        ag.anchor.set(Math.cos(ang) * dockR, Math.sin(ang) * dockR + bob, 0);
      }

      // critically-damped move toward anchor (tighter while travelling a route)
      const k = 1 - Math.exp(-moveStiff * d);
      ag.pos.x += (ag.anchor.x - ag.pos.x) * k;
      ag.pos.y += (ag.anchor.y - ag.pos.y) * k;
      ag.pos.z += (ag.anchor.z - ag.pos.z) * k;

      // push into trail ring
      ag.trailHead = (ag.trailHead + 1) % TRAIL_LEN;
      ag.trail[ag.trailHead * 3] = ag.pos.x;
      ag.trail[ag.trailHead * 3 + 1] = ag.pos.y;
      ag.trail[ag.trailHead * 3 + 2] = ag.pos.z;
    }

    // --- agent → agent handoff packets ---
    // A bright "information" packet arcs along the edge between two chips when
    // one agent feeds work to another. Reads agents' LIVE positions (updated just
    // above) so the arc tracks them. On arrival the receiver flashes (it caught it).
    for (let i = 0; i < HANDOFF_MAX; i++) {
      if (this.hIntensity[i] <= 0.001) {
        this.hBright[i] = 0;
        continue;
      }
      const from = this.agents[this.hFrom[i]];
      const to = this.agents[this.hTo[i]];
      const p = this.hProg[i] + this.hSpeed[i] * d;
      if (p >= 1 || !from || !to) {
        if (to) to.intensity = Math.min(1.5, to.intensity + 0.45 * this.hIntensity[i]);
        this.hIntensity[i] = 0;
        this.hBright[i] = 0;
        continue;
      }
      this.hProg[i] = p;
      const ax = from.pos.x, ay = from.pos.y, az = from.pos.z;
      const bx = to.pos.x, by = to.pos.y, bz = to.pos.z;
      const dx = bx - ax, dy = by - ay;
      const planar = Math.hypot(dx, dy) || 1;
      const len = Math.hypot(dx, dy, bz - az) || 1;
      // bowed arc: midpoint pushed along the in-plane perpendicular + toward camera
      const bow = Math.min(len * 0.22, 3.2);
      const mx = (ax + bx) * 0.5 + (-dy / planar) * bow;
      const my = (ay + by) * 0.5 + (dx / planar) * bow;
      const mz = (az + bz) * 0.5 + Math.min(len * 0.12, 2.0) + 1.0;
      const mt = 1 - p;
      const w0 = mt * mt, w1 = 2 * mt * p, w2 = p * p;
      this.hPos[i * 3] = w0 * ax + w1 * mx + w2 * bx;
      this.hPos[i * 3 + 1] = w0 * ay + w1 * my + w2 * by;
      this.hPos[i * 3 + 2] = w0 * az + w1 * mz + w2 * bz;
      this.hBright[i] = this.hIntensity[i] * Math.sin(p * Math.PI);
    }

    // --- milestone → milestone JOURNEY handoffs ---
    // A warm "work product" packet flows along the roadmap from a completed
    // milestone to the one it feeds. Endpoints are NODE positions (morph-blended),
    // so it rides the corridor; brightness is gated on the morph so it only reads
    // in the time-corridor and fades out as you morph back to the brain. On arrival
    // the target milestone lights up - it caught the work.
    const jmVis = smoothBand(this.morph, 0.25, 0.55); // 0 in brain → 1 in journey
    for (let i = 0; i < MHANDOFF_MAX; i++) {
      if (this.mIntensity[i] <= 0.001) {
        this.mBright[i] = 0;
        continue;
      }
      const a = this.mFrom[i];
      const b = this.mTo[i];
      const p = this.mProg[i] + this.mSpeed[i] * d;
      if (p >= 1 || a < 0 || b < 0) {
        if (b >= 0) {
          this.bump(b, 0.55 * this.mIntensity[i]);
          this.nodeArrival[b] = Math.max(this.nodeArrival[b], Math.min(1, this.mIntensity[i]));
          this.nodeArrivalKind[b] = 1;
        }
        this.mIntensity[i] = 0;
        this.mBright[i] = 0;
        continue;
      }
      this.mProg[i] = p;
      const ax = this.pos[a * 3], ay = this.pos[a * 3 + 1], az = this.pos[a * 3 + 2];
      const bx = this.pos[b * 3], by = this.pos[b * 3 + 1], bz = this.pos[b * 3 + 2];
      const dx = bx - ax, dy = by - ay;
      const planar = Math.hypot(dx, dy) || 1;
      const len = Math.hypot(dx, dy, bz - az) || 1;
      // a generous bow (FLOORED so same-lane neighbours still arc visibly) lifted
      // toward camera so the packet flows clearly ABOVE the corridor plane
      const bow = Math.min(Math.max(len * 0.26, 1.4), 5.0);
      const mx = (ax + bx) * 0.5 + (-dy / planar) * bow;
      const my = (ay + by) * 0.5 + (dx / planar) * bow;
      const mz = (az + bz) * 0.5 + Math.min(len * 0.16, 3.0) + 1.4;
      const mt = 1 - p;
      const w0 = mt * mt, w1 = 2 * mt * p, w2 = p * p;
      this.mPos[i * 3] = w0 * ax + w1 * mx + w2 * bx;
      this.mPos[i * 3 + 1] = w0 * ay + w1 * my + w2 * by;
      this.mPos[i * 3 + 2] = w0 * az + w1 * mz + w2 * bz;
      this.mBright[i] = this.mIntensity[i] * Math.sin(p * Math.PI) * jmVis;
    }
  }

  private distToNode(i: number): number {
    if (i < 0) return 1e6;
    const dx = this.pos[i * 3] - this._cam.x;
    const dy = this.pos[i * 3 + 1] - this._cam.y;
    const dz = this.pos[i * 3 + 2] - this._cam.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
}

/** 1 when dist<=near, 0 when dist>=far, smooth between. */
function revealBand(dist: number, near: number, far: number): number {
  if (dist <= near) return 1;
  if (dist >= far) return 0;
  const t = (far - dist) / (far - near);
  return t * t * (3 - 2 * t);
}

/** 0 when x<=lo, 1 when x>=hi, smoothstep between (rising - complements revealBand). */
function smoothBand(x: number, lo: number, hi: number): number {
  if (x <= lo) return 0;
  if (x >= hi) return 1;
  const t = (x - lo) / (hi - lo);
  return t * t * (3 - 2 * t);
}

/** Deterministic 0..1 from a string (stagger/lift seeds - no Math.random). */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}
