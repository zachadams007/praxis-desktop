/**
 * galaxyEngine.ts - the custom star-atlas canvas engine (ported from the Memory Galaxy
 * design prototype's Component class). A single <canvas> driven by this class's own
 * requestAnimationFrame loop: force sim (tick), camera (pan/zoom/fly-to), draw()/loop(),
 * sprite-glow caching, nebula fog, celestial graticule, traffic beads, arrival flashes,
 * agent-rig roaming (via agentRig.ts), and the live PraxisEvent bridge (applyEvent).
 *
 * ARCHITECTURE (binding): every per-frame value - node positions/velocities, camera,
 * agent bodies, beads, animation queues - lives here as imperative instance fields mutated
 * in the rAF loop. React state is only touched via the discrete callbacks in EngineConfig
 * (selection, agent drill-in, the live-readout tick). Same reasoning as src/data/eventBus.ts.
 */
import {
  AREA,
  AREAS,
  clamp,
  mix,
  mulberry32,
  rgbOf,
  rgba as rgbaHex,
} from "./atlas";
import { drawAgents, MODEL_TINT, orbitR } from "./agentRig";
import type { GraphData } from "./types";
import type {
  AgentBody,
  AgentOp,
  Bead,
  EngineAgent,
  Flash,
  SimEdge,
  SimNode,
} from "./engineTypes";
import type { GraphSettings } from "./graphSettings";

const ICE = "#DFE9FF";
const STRUCT = "#6C8CFF";

/** A single live-vault-mutation event (the DC's narrow applyEvent vocabulary). */
export interface VaultEvent {
  type: "read" | "write" | "link" | "create";
  agent: string;
  path: string; // node id OR label
  to?: string;
  label?: string;
  x?: number;
  y?: number;
}

export interface EngineConfig {
  canvas: HTMLCanvasElement;
  root: HTMLElement;
  /** discrete → React: a node was selected (id) or deselected (null). */
  onSelect: (id: string | null) => void;
  /** discrete → React: an agent rig was clicked to drill in. */
  onOpenAgent?: (id: string) => void;
  /** discrete → React: the graph mutated (new node / new link) - re-derive chrome counts. */
  onGraphMutate?: () => void;
  /** per-frame-ish → React: the α/δ/× readout text (called throttled). */
  onReadout?: (text: string) => void;
}

const DEG = Math.PI / 180;

// Click-vs-drag tolerance (euclidean px, screen space). A pointerdown that travels less than
// this before pointerup is a CLICK (selects the node); past it, it's a drag (pins/moves the
// node). Below the threshold the node's position is NEVER touched and the sim is NEVER
// reheated - a heavy-handed click on a hub used to read as a micro-drag that pinned the hub
// a few px off and jiggled the whole cluster ("hub vibrates on click", 2026-07-10 QA).
const DRAG_THRESH = 5;

export class GalaxyEngine {
  private cfg: EngineConfig;
  private canvas: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private root: HTMLElement;

  // --- data ---
  nodes: SimNode[] = [];
  edges: SimEdge[] = [];
  byId = new Map<string, SimNode>();
  adj = new Map<string, Set<string>>();
  edgeMap = new Map<string, SimEdge>();
  labelId: Record<string, string> = {};
  private slots: Record<string, { x: number; y: number }> = {};

  // --- agents ---
  agents: EngineAgent[] = [];
  agentBodies: Record<string, AgentBody> | null = null;

  // --- settings + props ---
  settings: GraphSettings;
  accent = "#ff2d2d";
  grid = true;
  ambient = true;
  /** May the ambient scheduler INVENT vault facts - new stars (`create`) and new
   *  links (`link`)? Those mutate the graph with fabricated content (labels come
   *  from the hardcoded CREATE_STEMS table), so a viewer reads them as "an
   *  artifact was just captured and linked". That is a literal claim, and literal
   *  claims must be real. FALSE in the app; true only for the browser demo /
   *  screenshot previews that have no backend to be honest about.
   *  Traffic beads and flashes (`read`/`write`) stay on either way - they are
   *  ambience, they mutate nothing, and the visual-truth rule allows ambience to
   *  breathe. */
  fabricate = false;
  colorMode: "areas" | "mono" = "areas";

  // --- imperative sim/camera state ---
  cam = { scale: 1, tx: 0, ty: 0 };
  /** Node ids a working agent is focused on right now - see refreshLiveNodes(). */
  private liveNodes = new Set<string>();
  private hovered: string | null = null;
  selected: string | null = null;
  private alpha = 1;
  private tms = 0;
  private flyTarget: {
    cx: number;
    cy: number;
    scale: number;
    ucx: number;
    ucy: number;
    ease: number;
  } | null = null;
  private drag: { id: string; moved: boolean; x: number; y: number } | null = null;
  /** depChain memo - draw() needs the active node's dependency chain EVERY FRAME while a node
   *  is hovered/selected; recomputing it per frame walks every edge repeatedly. Keyed by the
   *  active node id; invalidated when the edge set changes (weave / buildSim). */
  private _chainFor: string | null = null;
  private _chainSet: Set<string> | null = null;
  private panning: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
  reduced = false;
  private traffic: Bead[] = [];
  private flashes: Flash[] = [];

  // dims
  private W = 0;
  private H = 0;
  private dpr = 1;
  private FS = 5;
  private fogCv?: HTMLCanvasElement;
  private fctx?: CanvasRenderingContext2D | null;

  // sprite cache
  private _gs: Record<string, HTMLCanvasElement> = {};

  // stars
  private stars: Array<{
    depth: number;
    a: number;
    pts: Array<{ x: number; y: number; r: number; ph: number; sp: number; warm: boolean }>;
  }> = [];

  // loop bookkeeping
  private _raf = 0;
  private _rf = 0;
  private _lastAg = 0;
  private _nextT: Record<string, number> = {};
  private _liveN = 0;
  private _bornIx = 0;
  private _born = 0;
  private _woven = 0;
  private _ro?: ResizeObserver;
  private _logged = false;
  /** ms timestamp (engine rAF clock) of the last REAL push event received via the live bridge.
   *  0 = none yet. Drives realEventsAlive() → gates the ambient simulation off while reality
   *  is flowing. See markRealEvent / realEventsAlive. */
  private _lastRealEventAt = 0;

  // create stems per area (loose captures the create op bears)
  private CREATE_STEMS: Record<string, string[]> = {
    praxis: ["capture · fog density pass", "capture · label LOD notes", "capture · reticle spec", "capture · trail easing"],
    catalyzed: ["capture · wire retry notes", "capture · desk polish list"],
    learnai: ["capture · router tweak", "capture · skill audit"],
    finance: ["capture · spend snapshot", "capture · cap review"],
    ventures: ["capture · outreach note"],
    studio: ["capture · hook variant", "capture · render notes"],
    global: ["capture · working note"],
  };

  constructor(cfg: EngineConfig, data: GraphData, agents: EngineAgent[], settings: GraphSettings) {
    this.cfg = cfg;
    this.canvas = cfg.canvas;
    this.root = cfg.root;
    this.settings = settings;
    this.agents = agents;
    this.reduced =
      typeof window !== "undefined" &&
      !!window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.buildSim(data);
    this.makeStars();
  }

  // ---------- build the sim from GraphData ----------
  private buildSim(data: GraphData) {
    const rng = mulberry32(0x51a37);
    const gauss = () => (rng() + rng() + rng() - 1.5) / 1.5;
    const nodes: SimNode[] = [];
    const edges: SimEdge[] = [];
    this.slots = {};
    this.labelId = {};

    const addEdge = (s: string, t: string, kind: SimEdge["kind"], extra?: Partial<SimEdge>) => {
      edges.push({
        source: s,
        target: t,
        kind,
        jit: 0.75 + rng() * 0.6,
        bow: (rng() < 0.5 ? -1 : 1) * (0.05 + rng() * 0.07),
        L: 34 + rng() * 66,
        ...extra,
      });
    };

    // area anchors (only for areas actually present)
    const presentAreas = new Set(data.nodes.map((n) => n.area));
    for (const area of AREAS) {
      if (!presentAreas.has(area.id)) continue;
      this.slots[area.id] = { x: area.ax, y: area.ay };
    }

    // place every node; hubs anchor to their area slot, leaves scatter by a per-area sigma
    const countByArea: Record<string, number> = {};
    for (const n of data.nodes) countByArea[n.area] = (countByArea[n.area] || 0) + 1;
    const sigmaOf: Record<string, number> = {};
    for (const a of AREAS) sigmaOf[a.id] = clamp(9 * Math.sqrt(countByArea[a.id] || 1), 30, 76);

    for (const src of data.nodes) {
      const area = AREA[src.area] ?? AREA.global;
      const isHub = src.kind === "hub";
      const sigma = sigmaOf[src.area] || 40;
      const spread = isHub ? 8 : (src.minor ? sigma * 1.18 : sigma);
      const n: SimNode = {
        id: src.id,
        label: src.label,
        kind: isHub ? "hub" : "leaf",
        type: src.type,
        area: src.area,
        minor: !!src.minor,
        orphan: !!src.orphan,
        live: src.live,
        prog: src.prog,
        degree: src.degree || 0,
        description: src.description,
        meta: src.meta,
        slug: src.slug,
        tint: rng() * (src.minor ? 0.15 : 0.18),
        r: 2,
        x: area.ax + gauss() * spread,
        y: area.ay + gauss() * spread,
        vx: 0,
        vy: 0,
      };
      nodes.push(n);
      this.labelId[src.label] = src.id;
    }

    // edges from GraphData (member / link / dep)
    for (const e of data.edges) {
      addEdge(e.source, e.target, e.kind, { cross: e.cross });
    }

    // build lookups + degree (link/dep contribute; member is scaffolding)
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const adj = new Map<string, Set<string>>();
    nodes.forEach((n) => (n.degree = 0));
    const edgeMap = new Map<string, SimEdge>();
    for (const e of edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      if (e.kind !== "member") {
        a.degree++;
        b.degree++;
        edgeMap.set(e.source + "|" + e.target, e);
        edgeMap.set(e.target + "|" + e.source, e);
      }
      if (!adj.has(a.id)) adj.set(a.id, new Set());
      if (!adj.has(b.id)) adj.set(b.id, new Set());
      adj.get(a.id)!.add(b.id);
      adj.get(b.id)!.add(a.id);
    }
    nodes.forEach((n) => (n.r = this.nodeR(n)));
    // keep only edges whose endpoints exist
    const validEdges = edges.filter((e) => byId.has(e.source) && byId.has(e.target));

    this.nodes = nodes;
    this.edges = validEdges;
    this.byId = byId;
    this.adj = adj;
    this.edgeMap = edgeMap;
    this._chainFor = null;
    this._chainSet = null;
  }

  /** Node size is MEANING, not decoration - hubs largest, tasks above notes/refs, minor
   *  captures smallest; radius grows with real link degree (a proxy for importance). */
  private nodeR(n: SimNode): number {
    if (n.kind === "hub") return 5.4;
    if (n.minor) return 1.15 + Math.min(0.5, n.degree * 0.25) + (n.tint || 0) * 0.9;
    const base = n.type === "task" ? 2.6 : 1.9;
    return Math.min(4.6, base + Math.log1p(n.degree) * 0.9);
  }

  /** Resolve an agent focus (a node id OR a label the graph names) to a real node id. */
  private resolveFocus(focus: string | null): string | null {
    if (!focus) return null;
    return this.labelId[focus] || (this.byId.has(focus) ? focus : null);
  }

  private agentNode(ag: EngineAgent): string | null {
    const b = this.agentBodies && this.agentBodies[ag.id];
    if (b && b.nodeId) return b.nodeId;
    return this.resolveFocus(ag.focus);
  }

  /** Mark that a REAL push event just arrived on the live bridge. The galaxy's eventBus is fed
   *  ONLY by real Tauri push events (useGalaxyRealEvents) - there is no mock timeline in this
   *  window - so the arrival of ANY bus event is genuine activity. eventAdapter.ts calls this
   *  on every event; realEventsAlive() then keeps the ambient simulation suppressed for a decay
   *  window, so a brief gap between real beats doesn't let the mock traffic flicker back on. */
  markRealEvent(): void {
    this._lastRealEventAt = this.tms || performance.now();
  }

  /** True while real events have arrived recently (90s window). While alive, the ambient
   *  random-walk simulation stands down and rigs retarget from real focus; when it lapses
   *  (genuine cold idle) the ambient layer resumes as ambience. */
  private realEventsAlive(ts: number): boolean {
    return this._lastRealEventAt > 0 && ts - this._lastRealEventAt < 90000;
  }

  // ---------- lifecycle ----------
  mount() {
    this.applyRootVars();
    this.resize();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.root);
    for (let i = 0; i < 260; i++) this.tick(1 - i / 280);
    this.flyToFit(0);
    const f0 = this.flyTarget;
    if (f0) {
      this.cam.scale = f0.scale;
      this.cam.tx = f0.ucx - f0.cx * f0.scale;
      this.cam.ty = f0.ucy - f0.cy * f0.scale;
      this.flyTarget = null;
    }
    this.alpha = 0.05;
    const cv = this.canvas;
    cv.addEventListener("pointermove", this.onMove);
    cv.addEventListener("pointerdown", this.onDown);
    cv.addEventListener("dblclick", this.onDbl);
    window.addEventListener("pointerup", this.onUp);
    cv.addEventListener("pointerleave", this.onLeave);
    cv.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKey);
    document.addEventListener("visibilitychange", this.onVis);
    this._raf = requestAnimationFrame(this.loop);
  }

  unmount() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._ro?.disconnect();
    const cv = this.canvas;
    cv.removeEventListener("pointermove", this.onMove);
    cv.removeEventListener("pointerdown", this.onDown);
    cv.removeEventListener("dblclick", this.onDbl);
    cv.removeEventListener("pointerleave", this.onLeave);
    cv.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("keydown", this.onKey);
    document.removeEventListener("visibilitychange", this.onVis);
    // Drop the offscreen-canvas caches so a galaxy remount (Galaxy.tsx rebuilds the
    // engine whenever props.data changes) doesn't orphan the per-hex glow sprites and
    // the fog canvas - they'd otherwise accumulate across open/close cycles.
    this._gs = {};
    this.fogCv = undefined;
    this.fctx = null;
  }

  private applyRootVars() {
    const el = this.root;
    if (!el) return;
    const v: Record<string, string> = {
      "--p-bg": "#05060B",
      "--p-text": "#E9EEF7",
      "--p-dim": "#8B95AB",
      "--p-line": "rgba(167,181,212,.13)",
      "--p-line2": "rgba(167,181,212,.3)",
      "--p-accent": this.accent,
      "--p-blue": "#6C8CFF",
      "--p-serif": "'Spectral', Georgia, serif",
      "--p-mono": "'IBM Plex Mono', ui-monospace, monospace",
    };
    for (const k in v) el.style.setProperty(k, v[k]);
  }

  private resize = () => {
    const cv = this.canvas;
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    this.W = w;
    this.H = h;
    this.dpr = dpr;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    this.ctx = cv.getContext("2d")!;
    this.FS = 5;
    this.fogCv = this.fogCv || document.createElement("canvas");
    this.fogCv.width = Math.max(1, Math.round(w / this.FS));
    this.fogCv.height = Math.max(1, Math.round(h / this.FS));
    this.fctx = this.fogCv.getContext("2d");
  };

  // ---------- external setters (from React) ----------
  setSettings(s: GraphSettings) {
    const prev = this.settings;
    this.settings = s;
    if (prev.repel !== s.repel || prev.gravity !== s.gravity || prev.linkDist !== s.linkDist) {
      this.reheat(0.5);
    }
    // area filter toggled → re-fit
    for (const a of AREAS) {
      if (prev.shown[a.id] !== s.shown[a.id]) {
        this.reheat(0.2);
        setTimeout(() => this.flyToFit(), 20);
        break;
      }
    }
  }
  setAccent(a: string) {
    this.accent = a;
    this.applyRootVars();
  }
  setGrid(g: boolean) {
    this.grid = g;
  }
  setAmbient(a: boolean) {
    this.ambient = a;
  }
  setColorMode(m: "areas" | "mono") {
    this.colorMode = m;
  }
  setAgents(agents: EngineAgent[]) {
    this.agents = agents;
    // rebuild bodies lazily on next updateAgents (working set may have changed)
    this.agentBodies = null;
    this.refreshLiveNodes();
  }

  /** Which stars are being worked on RIGHT NOW.
   *
   *  SimNode.live is NOT this. It is authored once by the graph builder from a
   *  note's own text (a 🚧 / "in progress" marker in the intent ledger), so a note
   *  tagged months ago kept its pulsing "active" ring forever. Real liveness is a
   *  WORKING agent whose focus resolves to the node - recomputed on every roster
   *  update, so the ring goes out when the session does. */
  private refreshLiveNodes() {
    this.liveNodes.clear();
    for (const ag of this.agents) {
      if (ag.status !== "working") continue;
      const id = this.agentNode(ag);
      if (id) this.liveNodes.add(id);
    }
  }
  /** external select (from React clicking a neighbor / drill-in). */
  selectExternal(id: string | null) {
    this.select(id);
  }
  /** fly the camera to an agent's focus node (drill-in). */
  focusAgent(agId: string) {
    const ag = this.agents.find((a) => a.id === agId);
    if (!ag) return;
    const nid = this.agentNode(ag);
    const n = nid && this.byId.get(nid);
    if (n && this.visible(n)) this.flyToNode(n);
  }
  resetLayout() {
    this.nodes.forEach((n) => {
      n.fx = null;
      n.fy = null;
    });
    this.reheat(0.85);
    setTimeout(() => this.flyToFit(), 30);
  }

  // ---------- forces ----------
  visible(n: SimNode): boolean {
    const s = this.settings;
    if (!s.shown[n.area]) return false;
    if (n.orphan && !s.showOrphans) return false;
    return true;
  }
  private tick(boost?: number) {
    const a = Math.max(this.alpha, 0) * (boost || 1);
    if (a <= 0.0001) return;
    const s = this.settings;
    const nodes = this.nodes;
    const repel = s.repel * 2.2;
    const cen: Record<string, { x: number; y: number }> = {};
    const cnt: Record<string, number> = {};
    for (const n of nodes) {
      if (n.kind !== "leaf") continue;
      const t = n.area;
      (cen[t] = cen[t] || { x: 0, y: 0 });
      cnt[t] = (cnt[t] || 0) + 1;
      cen[t].x += n.x;
      cen[t].y += n.y;
    }
    for (const t in cen) {
      cen[t].x /= cnt[t];
      cen[t].y /= cnt[t];
    }
    for (let i = 0; i < nodes.length; i++) {
      const ni = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const nj = nodes[j];
        let dx = ni.x - nj.x;
        let dy = ni.y - nj.y;
        let d2 = dx * dx + dy * dy;
        if (d2 > 62500) continue;
        if (d2 < 1) {
          d2 = 1;
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
        }
        let f = ((repel * 20) / d2) * a;
        if (ni.kind === "hub" || nj.kind === "hub") f *= 2.2;
        const d = Math.sqrt(d2);
        const ux = dx / d;
        const uy = dy / d;
        ni.vx += ux * f;
        ni.vy += uy * f;
        nj.vx -= ux * f;
        nj.vy -= uy * f;
      }
    }
    // Member springs - FULLY SYMMETRIC, byte-identical to the DC (k=0.045 both ends). The MAXV
    // velocity clamp in the integrator below independently bounds the explosion, so symmetric
    // springs are safe AND restore the DC's looser, more-intermixed cluster spacing. Do NOT
    // re-bias these - match the DC.
    for (const e of this.edges) {
      const A = this.byId.get(e.source);
      const B = this.byId.get(e.target);
      if (!A || !B) continue;
      const member = e.kind === "member";
      const L = member ? e.L : s.linkDist * e.jit * (e.kind === "dep" ? 1.55 : 1);
      const k = member ? 0.045 : e.kind === "dep" ? 0.018 : 0.036;
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = ((d - L) / d) * k * a;
      const fx = dx * f;
      const fy = dy * f;
      A.vx += fx;
      A.vy += fy;
      B.vx -= fx;
      B.vy -= fy;
    }
    const cg = s.gravity * 0.9;
    for (const n of nodes) {
      n.vx += (0 - n.x) * cg * a;
      n.vy += (0 - n.y) * cg * a;
      if (n.kind === "hub") {
        const sl = this.slots[n.area];
        if (sl) {
          n.vx += (sl.x - n.x) * 0.014 * a;
          n.vy += (sl.y - n.y) * 0.014 * a;
        }
      } else {
        const c = cen[n.area];
        if (c) {
          const kk = n.orphan ? 0.011 : 0.0055;
          n.vx += (c.x - n.x) * kk * a;
          n.vy += (c.y - n.y) * kk * a;
        }
      }
    }
    const VD = 0.6;
    // Hard speed ceiling (world-units/tick): a universal integrator stabilizer. Settled
    // motion is ≪ 1 unit/tick so this is invisible in normal operation - it only binds
    // when some force pathology tries to catapult nodes, keeping any failure bounded and
    // recoverable instead of exponential.
    const MAXV = 24;
    for (const n of nodes) {
      if (n.fx != null) {
        n.x = n.fx;
        n.y = n.fy!;
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx *= VD;
      n.vy *= VD;
      const sp2 = n.vx * n.vx + n.vy * n.vy;
      if (sp2 > MAXV * MAXV) {
        const q = MAXV / Math.sqrt(sp2);
        n.vx *= q;
        n.vy *= q;
      }
      n.x += n.vx;
      n.y += n.vy;
    }
    for (let i = 0; i < nodes.length; i++) {
      const ni = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const nj = nodes[j];
        const dx = nj.x - ni.x;
        const dy = nj.y - ni.y;
        const min = ni.r + nj.r + 1.3;
        const d2 = dx * dx + dy * dy;
        if (d2 < min * min && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const push = ((min - d) / d) * 0.45;
          const px = dx * push;
          const py = dy * push;
          if (ni.fx == null) {
            ni.x -= px;
            ni.y -= py;
          }
          if (nj.fx == null) {
            nj.x += px;
            nj.y += py;
          }
        }
      }
    }
    this.alpha = Math.max(0, this.alpha - this.alpha * 0.024);
  }
  reheat(v: number) {
    this.alpha = Math.max(this.alpha, v);
  }

  // ---------- camera ----------
  private pads() {
    const p = { left: 262, right: 364, top: 70, bottom: 58 };
    const minStage = 140;
    if (p.left + p.right > this.W - minStage) {
      const k = Math.max(0, this.W - minStage) / (p.left + p.right);
      p.left = Math.max(16, p.left * k);
      p.right = Math.max(16, p.right * k);
    }
    if (p.top + p.bottom > this.H - 80) {
      const k = Math.max(0, this.H - 80) / (p.top + p.bottom);
      p.top = Math.max(12, p.top * k);
      p.bottom = Math.max(12, p.bottom * k);
    }
    return p;
  }
  private flyToNodes(
    list: SimNode[],
    opt?: { instant?: boolean; fit?: number; maxScale?: number },
  ) {
    opt = opt || {};
    const ns = (list || []).filter(Boolean);
    if (!ns.length) return;
    let minX = 1e9,
      minY = 1e9,
      maxX = -1e9,
      maxY = -1e9;
    for (const n of ns) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
    }
    const p = this.pads();
    const availW = Math.max(120, this.W - p.left - p.right);
    const availH = Math.max(120, this.H - p.top - p.bottom);
    const bw = Math.max(40, maxX - minX);
    const bh = Math.max(40, maxY - minY);
    const fit = opt.fit != null ? opt.fit : 0.94;
    const scale = clamp(
      Math.min(availW / bw, availH / bh) * fit,
      0.18,
      opt.maxScale != null ? opt.maxScale : 3,
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const ucx = p.left + availW / 2;
    const ucy = p.top + availH / 2;
    this.flyTarget = { cx, cy, scale, ucx, ucy, ease: opt.instant ? 1 : 0.12 };
  }
  flyToFit(ms?: number) {
    this.flyToNodes(
      this.nodes.filter((n) => this.visible(n)),
      { instant: ms === 0 },
    );
  }
  private flyToNode(n: SimNode) {
    const p = this.pads();
    const availW = Math.max(120, this.W - p.left - p.right);
    const availH = Math.max(120, this.H - p.top - p.bottom);
    const ucx = p.left + availW / 2;
    const ucy = p.top + availH / 2;
    const scale = clamp(Math.max(this.cam.scale, 1.9), 0.25, 3.4);
    this.flyTarget = { cx: n.x, cy: n.y, scale, ucx, ucy, ease: 0.12 };
  }
  private stepCamera() {
    const f = this.flyTarget;
    if (!f) return;
    const e = f.ease;
    this.cam.scale += (f.scale - this.cam.scale) * e;
    const tx = f.ucx - f.cx * this.cam.scale;
    const ty = f.ucy - f.cy * this.cam.scale;
    this.cam.tx += (tx - this.cam.tx) * (e + 0.04);
    this.cam.ty += (ty - this.cam.ty) * (e + 0.04);
    if (Math.abs(f.scale - this.cam.scale) < 0.002) this.flyTarget = null;
  }
  private toScreen = (n: { x: number; y: number }) => ({
    x: n.x * this.cam.scale + this.cam.tx,
    y: n.y * this.cam.scale + this.cam.ty,
  });
  private toWorld(px: number, py: number) {
    return { x: (px - this.cam.tx) / this.cam.scale, y: (py - this.cam.ty) / this.cam.scale };
  }
  private screenR = (n: SimNode) =>
    Math.max(1.3, n.r * this.cam.scale * this.settings.nodeScale);
  private pick(px: number, py: number): SimNode | null {
    let best: SimNode | null = null;
    let bd = 1e9;
    for (const n of this.nodes) {
      if (!this.visible(n)) continue;
      const s = this.toScreen(n);
      const r = this.screenR(n) + 7;
      const d = (px - s.x) ** 2 + (py - s.y) ** 2;
      if (d < r * r && d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  // ---------- pointer ----------
  private onMove = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (this.drag) {
      // Below the click tolerance this is still a click, not a drag - don't mark moved and
      // don't pin/nudge the node, so onUp still fires select() and the inspector populates.
      if (!this.drag.moved) {
        const ddx = e.clientX - this.drag.x;
        const ddy = e.clientY - this.drag.y;
        if (ddx * ddx + ddy * ddy <= DRAG_THRESH * DRAG_THRESH) return;
      }
      this.drag.moved = true;
      const w = this.toWorld(px, py);
      const n = this.byId.get(this.drag.id);
      if (n) {
        n.fx = w.x;
        n.fy = w.y;
      }
      this.flyTarget = null;
      this.reheat(0.4);
      return;
    }
    if (this.panning) {
      this.cam.tx = this.panning.tx + (e.clientX - this.panning.x);
      this.cam.ty = this.panning.ty + (e.clientY - this.panning.y);
      this.panning.moved =
        Math.abs(e.clientX - this.panning.x) + Math.abs(e.clientY - this.panning.y) > 4;
      this.flyTarget = null;
      return;
    }
    const hit = this.pick(px, py);
    this.hovered = hit ? hit.id : null;
    this.canvas.style.cursor = hit ? "pointer" : "grab";
  };
  /** Double-click a user-pinned hub to release it back into the simulation
   *  (drag pins hubs where dropped - see onUp). */
  private onDbl = (e: MouseEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const hit = this.pick(e.clientX - rect.left, e.clientY - rect.top);
    if (hit && hit.kind === "hub" && (hit.fx != null || hit.fy != null)) {
      hit.fx = null;
      hit.fy = null;
      this.reheat(0.5);
    }
  };
  private onDown = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const hit = this.pick(px, py);
    if (hit) {
      // Do NOT pin on down - pinning + the moved flag only kick in once the pointer travels past
      // DRAG_THRESH (see onMove). This keeps a click (down→up with tiny jitter) a clean
      // selection instead of a zero-distance drag that nudged the node and skipped select().
      this.drag = { id: hit.id, moved: false, x: e.clientX, y: e.clientY };
      this.canvas.style.cursor = "grabbing";
    } else {
      this.panning = { x: e.clientX, y: e.clientY, tx: this.cam.tx, ty: this.cam.ty, moved: false };
      this.canvas.style.cursor = "grabbing";
    }
  };
  private onUp = () => {
    if (this.drag) {
      const n = this.byId.get(this.drag.id);
      if (!this.drag.moved) this.select(this.drag.id);
      else if (n) {
        if (n.kind === "hub") {
        } else {
          n.fx = null;
          n.fy = null;
        }
        this.reheat(0.45);
      }
      this.drag = null;
    } else if (this.panning) {
      if (!this.panning.moved) this.select(null);
      this.panning = null;
    }
    this.canvas.style.cursor = "grab";
  };
  private onLeave = () => {
    this.hovered = null;
  };
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const w = this.toWorld(px, py);
    const ns = clamp(this.cam.scale * Math.exp(-e.deltaY * 0.0014), 0.18, 6);
    this.cam.scale = ns;
    this.cam.tx = px - w.x * ns;
    this.cam.ty = py - w.y * ns;
    this.flyTarget = null;
  };
  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (this.selected) this.select(null);
      else this.flyToFit();
    }
  };
  private onVis = () => {
    if (document.hidden) {
      // Window hidden (tray / other window) - STOP the rAF loop entirely. The galaxy's
      // O(n²) force sim over ~950 nodes was previously running full-tilt in the
      // background forever; the loop only re-requested itself, so it never idled.
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    } else if (!this._raf) {
      // Visible again - restart the loop (guard against double-start: only if stopped).
      this._raf = requestAnimationFrame(this.loop);
    }
  };

  select(id: string | null) {
    if (id) {
      const n = this.byId.get(id);
      if (!n) return;
      this.selected = id;
      this.hovered = null;
      this.cfg.onSelect(id);
      if (n.type === "task") {
        const near = new Set<string>([id]);
        for (const e of this.edges) {
          if (e.kind !== "dep") continue;
          if (e.source === id) near.add(e.target);
          if (e.target === id) near.add(e.source);
        }
        this.flyToNodes(
          [...near].map((i) => this.byId.get(i)!).filter(Boolean),
          { maxScale: 2.2, fit: 0.58 },
        );
      } else this.flyToNode(n);
    } else {
      this.selected = null;
      this.cfg.onSelect(null);
      this.flyToFit();
    }
  }
  /** Memoized wrapper - draw() calls this every frame for the active node. */
  private depChainCached(id: string): Set<string> {
    if (this._chainFor !== id || !this._chainSet) {
      this._chainSet = this.depChain(id);
      this._chainFor = id;
    }
    return this._chainSet;
  }
  private depChain(id: string): Set<string> {
    const out = new Set<string>([id]);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of this.edges) {
        if (e.kind !== "dep") continue;
        if (e.source === cur && !out.has(e.target)) {
          out.add(e.target);
          stack.push(e.target);
        }
        if (e.target === cur && !out.has(e.source)) {
          out.add(e.source);
          stack.push(e.source);
        }
      }
    }
    return out;
  }

  // ---------- ambient traffic (mock scheduler - OFF while real events flow) ----------
  // The random read/write scheduler below is ambience for the COLD-IDLE galaxy only. Once real
  // push events are flowing (realEventsAlive), it stands down entirely so the only traffic beads
  // + flashes on screen are driven by genuine agent activity via applyEvent. The bead/flash
  // decay still runs every frame regardless (real events push beads too).
  private ambientTick(ts: number) {
    if (!this.ambient || this.reduced) {
      this.traffic.length = 0;
      this.flashes.length = 0;
      return;
    }
    if (!this.realEventsAlive(ts)) {
      let idx = 0;
      for (const ag of this.agents) {
        idx++;
        if (ag.status !== "working") continue;
        const nid = this.agentNode(ag);
        const n = nid && this.byId.get(nid);
        if (!n || !this.visible(n)) continue;
        if (!this._nextT[ag.id]) this._nextT[ag.id] = ts + 1200 + idx * 800;
        if (ts >= this._nextT[ag.id]) {
          this._nextT[ag.id] = ts + 4200 + Math.random() * 4800;
          this.applyEvent({
            type: Math.random() < 0.45 ? "write" : "read",
            agent: ag.id,
            path: nid!,
          });
        }
      }
    }
    for (const p of this.traffic) {
      if (!p.done && ts - p.t0 >= p.dur) {
        p.done = true;
        this.flashes.push({ id: p.to, t0: ts, hue: p.write ? this.accent : "#8FB4FF" });
      }
    }
    this.traffic = this.traffic.filter((p) => ts - p.t0 < p.dur);
    this.flashes = this.flashes.filter((f) => ts - f.t0 < 520);
  }

  // ---------- agent bodies: fly in, roam the vault, plow through the web ----------
  private updateAgents(ts: number) {
    const still = !this.ambient || this.reduced;
    // While real events flow, rig movement follows the agent's REAL focus (below) instead of
    // the random nextTarget walk, and agentOp fires no simulated create/link ops.
    const alive = this.realEventsAlive(ts);
    if (!this.agentBodies) {
      this.agentBodies = {};
      let i = 0;
      for (const ag of this.agents) {
        if (ag.status !== "working") continue;
        const nid = (ag.focus && (this.labelId[ag.focus] || (this.byId.has(ag.focus) ? ag.focus : null))) || this.fallbackNodeFor(ag);
        const n = nid && this.byId.get(nid);
        if (!n) {
          i++;
          continue;
        }
        const ang = Math.atan2(n.y, n.x) + (i - 2) * 0.35;
        const R = 520 + i * 45;
        this.agentBodies[ag.id] = still
          ? {
              x: n.x + orbitR(n, this.cam.scale),
              y: n.y,
              nodeId: nid!,
              state: "dwell",
              dwellUntil: Infinity,
              ang: i * 2.1,
              ph: i * 2.4,
              ops: [],
              flare: 0,
              trail: [],
              lastP: null,
              holdUntil: 0,
            }
          : {
              x: Math.cos(ang) * R,
              y: Math.sin(ang) * R,
              nodeId: nid!,
              state: "travel",
              dwellUntil: 0,
              ang: i * 2.1,
              ph: i * 2.4,
              ops: [],
              flare: 0,
              trail: [],
              lastP: null,
              holdUntil: ts + i * 1100,
            };
        i++;
      }
      this._lastAg = ts;
    }
    const dt = Math.min(0.05, Math.max(0.001, (ts - (this._lastAg || ts)) / 1000));
    this._lastAg = ts;
    for (const id in this.agentBodies) {
      const b = this.agentBodies[id];
      if (!b.ops) {
        b.ops = [];
        b.ph = b.ph == null ? 1.9 : b.ph;
        b.flare = 0;
      }
      const node = this.byId.get(b.nodeId);
      if (!node) continue;
      b.flare = Math.max(0, (b.flare || 0) - dt * 0.8);
      if (still) {
        b.state = "dwell";
        b.dwellUntil = Infinity;
        b.ops.length = 0;
        b.x = node.x + Math.cos(b.ang) * orbitR(node, this.cam.scale);
        b.y = node.y + Math.sin(b.ang) * orbitR(node, this.cam.scale);
        b.trail.length = 0;
        continue;
      }
      if (ts < b.holdUntil) continue;
      if (b.state === "travel") {
        const dx = node.x - b.x;
        const dy = node.y - b.y;
        const d = Math.hypot(dx, dy) || 0.01;
        if (d < node.r + 12) {
          b.state = "dwell";
          b.dwellUntil = ts + 6000 + Math.random() * 8000;
          b.ang = Math.atan2(b.y - node.y, b.x - node.x);
          b.ops.push({ type: "read", t0: ts, dur: 1600, nodeId: b.nodeId });
          b.flare = Math.max(b.flare, 0.8);
          this.reheat(0.06);
        } else {
          const sp = Math.max(28, Math.min(95, d * 0.9));
          const ux = dx / d;
          const uy = dy / d;
          const sway = Math.sin(ts * 0.0009 + b.ang * 3) * 14;
          b.x += (ux * sp - uy * sway * 0.5) * dt;
          b.y += (uy * sp + ux * sway * 0.5) * dt;
          this.plow(b, dt);
          this.alpha = Math.max(this.alpha, 0.024);
        }
      } else {
        b.ang += dt * (0.22 + (b.flare || 0) * 0.3);
        const R = orbitR(node, this.cam.scale);
        b.x = node.x + Math.cos(b.ang) * R;
        b.y = node.y + Math.sin(b.ang) * R;
        if (ts >= b.dwellUntil) {
          this.agentOp(id, b, ts); // no-ops while real events are alive
          let next: string;
          if (alive) {
            // real focus drives the target - resolve the agent's live focus to a node; if it
            // doesn't resolve to something in THIS graph, hold at the current (area) anchor
            // rather than random-walking away from where the real work is.
            const ag = this.agents.find((a) => a.id === id);
            next = (ag && this.resolveFocus(ag.focus)) || b.nodeId;
          } else {
            next = this.nextTarget(id, b);
          }
          if (next && next !== b.nodeId) {
            b.nodeId = next;
            b.state = "travel";
          } else b.dwellUntil = ts + 12000 + Math.random() * 10000;
        }
      }
      if (
        !b.lastP ||
        (b.x - b.lastP.x) * (b.x - b.lastP.x) + (b.y - b.lastP.y) * (b.y - b.lastP.y) > 0.5
      ) {
        b.trail.push({ x: b.x, y: b.y, t: ts });
        b.lastP = { x: b.x, y: b.y };
        if (b.trail.length > 30) b.trail.shift();
      }
    }
  }
  /** if an agent has no resolvable focus node, put it on one of its areas' hub / a leaf. */
  private fallbackNodeFor(ag: EngineAgent): string | null {
    const area = ag.touches[0];
    // map an AgentRow.touches display name (e.g. "Praxis") to an area id if possible
    const aid = AREAS.find((a) => a.name === area || a.id === area)?.id;
    if (aid) {
      const hub = this.byId.get("hub." + aid);
      if (hub) return hub.id;
      const leaf = this.nodes.find((n) => n.area === aid && n.kind === "leaf" && this.visible(n));
      if (leaf) return leaf.id;
    }
    const anyLeaf = this.nodes.find((n) => n.kind === "leaf" && this.visible(n));
    return anyLeaf ? anyLeaf.id : null;
  }
  private plow(b: AgentBody, dt: number) {
    const R = 17;
    for (const n of this.nodes) {
      if (n.fx != null) continue;
      const dx = n.x - b.x;
      const dy = n.y - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > R * R || d2 < 0.01) continue;
      const d = Math.sqrt(d2);
      const f = ((1 - d / R) * 46 * dt) / d;
      n.vx += dx * f;
      n.vy += dy * f;
    }
  }
  private nextTarget(agId: string, b: AgentBody): string {
    const cur = this.byId.get(b.nodeId);
    if (!cur) return b.nodeId;
    const nbrs = [...(this.adj.get(b.nodeId) || [])].filter((id) => {
      const m = this.byId.get(id);
      return m && this.visible(m);
    });
    if (nbrs.length && Math.random() < 0.7) return nbrs[(Math.random() * nbrs.length) | 0];
    const pool = this.nodes.filter(
      (n) => n.kind === "leaf" && n.area === cur.area && n.id !== b.nodeId && this.visible(n),
    );
    if (!pool.length) return b.nodeId;
    pool.sort(
      (p, q) =>
        (p.x - cur.x) * (p.x - cur.x) +
        (p.y - cur.y) * (p.y - cur.y) -
        ((q.x - cur.x) * (q.x - cur.x) + (q.y - cur.y) * (q.y - cur.y)),
    );
    return pool[(Math.random() * Math.min(8, pool.length)) | 0].id;
  }
  private agentOp(agId: string, b: AgentBody, ts: number) {
    if (!this.ambient || this.reduced) return;
    // While real events flow, the rig performs NO simulated create/link/write ops - only the
    // real applyEvent stream mutates the vault.
    if (this.realEventsAlive(ts)) return;
    // In the app the rig may only PULSE existing stars. Inventing a star or a
    // link would put a fabricated vault fact on screen - and a fabricated star is
    // also a dead click, since App.tsx's byId map only knows real graph nodes.
    if (!this.fabricate) {
      this.applyEvent({ type: "write", agent: agId, path: b.nodeId });
      return;
    }
    const r = Math.random();
    if (r < 0.24 && (this._born || 0) < 14)
      this.applyEvent({ type: "create", agent: agId, path: b.nodeId, x: b.x, y: b.y });
    else if (r < 0.48 && (this._woven || 0) < 16)
      this.applyEvent({ type: "link", agent: agId, path: b.nodeId });
    else this.applyEvent({ type: "write", agent: agId, path: b.nodeId });
  }

  // ---------- the PraxisEvent bridge (the DC's narrow vault vocabulary) ----------
  applyEvent(ev: VaultEvent) {
    const ts = this.tms || 0;
    const rid = (p?: string) =>
      p ? this.labelId[p] || (this.byId.has(p) ? p : null) : null;
    const nid = rid(ev.path);
    if (!nid) return;
    const ag = this.agents.find((a) => a.id === ev.agent);
    const tint = ag ? MODEL_TINT[ag.fam] || "#8FB4FF" : "#8FB4FF";
    const body = (this.agentBodies && this.agentBodies[ev.agent]) || null;
    const bodyOp = (type: AgentOp["type"], target: string, dur: number) => {
      if (!body) return;
      body.ops = body.ops || [];
      body.ops.push({ type, t0: ts, dur, nodeId: target });
      body.flare = 1;
    };
    if (ev.type === "read" || ev.type === "write") {
      const write = ev.type === "write";
      let to = rid(ev.to);
      if (!to) {
        const cand = [...(this.adj.get(nid) || [])].filter((id) =>
          this.edgeMap.has(nid + "|" + id),
        );
        if (cand.length) to = cand[(Math.random() * cand.length) | 0];
      }
      if (to)
        this.traffic.push({
          from: write ? nid : to,
          to: write ? to : nid,
          t0: ts,
          dur: 950 + Math.random() * 550,
          write,
          tint,
        });
      bodyOp(ev.type, nid, 1600);
    } else if (ev.type === "link") {
      let to = rid(ev.to);
      if (!to) {
        const n = this.byId.get(nid)!;
        let best: SimNode | null = null;
        let bd = 1e9;
        for (const m of this.nodes) {
          if (m.kind !== "leaf" || m.id === nid || m.area !== n.area || m.orphan) continue;
          if (this.edgeMap.has(nid + "|" + m.id)) continue;
          const d = (m.x - n.x) * (m.x - n.x) + (m.y - n.y) * (m.y - n.y);
          if (d < bd) {
            bd = d;
            best = m;
          }
        }
        if (best && bd < 90 * 90) to = best.id;
      }
      if (!to || to === nid || this.edgeMap.has(nid + "|" + to)) return;
      this.weave(nid, to, ts);
      this.flashes.push({ id: to, t0: ts, hue: "#35D3C0" });
      bodyOp("link", to, 1300);
    } else if (ev.type === "create") {
      const born = this.bear(ev, nid, ts, tint);
      if (born) bodyOp("create", born.id, 1500);
    }
  }
  private weave(aId: string, bId: string, ts: number) {
    const A = this.byId.get(aId);
    const B = this.byId.get(bId);
    if (!A || !B) return;
    const dd = Math.hypot(B.x - A.x, B.y - A.y);
    const jit = clamp((dd * 0.85) / (this.settings.linkDist || 66), 0.6, 1.5);
    const e: SimEdge = {
      source: aId,
      target: bId,
      kind: "link",
      jit,
      bow: (Math.random() < 0.5 ? -1 : 1) * (0.05 + Math.random() * 0.07),
      L: 40,
      bornAt: ts,
      cross: A.area !== B.area,
    };
    this.edges.push(e);
    this.edgeMap.set(aId + "|" + bId, e);
    this.edgeMap.set(bId + "|" + aId, e);
    if (!this.adj.has(aId)) this.adj.set(aId, new Set());
    if (!this.adj.has(bId)) this.adj.set(bId, new Set());
    this.adj.get(aId)!.add(bId);
    this.adj.get(bId)!.add(aId);
    A.degree++;
    B.degree++;
    A.r = this.nodeR(A);
    B.r = this.nodeR(B);
    // edge set changed → the memoized dependency chain may be stale
    this._chainFor = null;
    this._chainSet = null;
    this._woven = (this._woven || 0) + 1;
    this.reheat(0.1);
    this.cfg.onGraphMutate?.();
  }
  private bear(ev: VaultEvent, parentId: string, ts: number, tint: string): SimNode | undefined {
    const P = this.byId.get(parentId);
    if (!P) return;
    const area = P.area || "praxis";
    const stems = this.CREATE_STEMS[area] || ["capture · working note"];
    const label = ev.label || stems[this._bornIx % stems.length];
    this._bornIx++;
    if (this.labelId[label]) return;
    const id = "live:" + (this._liveN = (this._liveN || 0) + 1);
    const x = ev.x != null ? ev.x : P.x + (Math.random() - 0.5) * 22;
    const y = ev.y != null ? ev.y : P.y + (Math.random() - 0.5) * 22;
    const n: SimNode = {
      id,
      label,
      kind: "leaf",
      type: "capture",
      area,
      minor: true,
      orphan: false,
      tint: Math.random() * 0.15,
      degree: 0,
      x,
      y,
      vx: 0,
      vy: 0,
      bornAt: ts,
      r: 1.3,
    };
    n.r = this.nodeR(n);
    this.nodes.push(n);
    this.byId.set(id, n);
    this.labelId[label] = id;
    this.weave(id, parentId, ts);
    this._woven = Math.max(0, (this._woven || 1) - 1);
    this._born = (this._born || 0) + 1;
    this.flashes.push({ id, t0: ts, hue: tint });
    this.cfg.onGraphMutate?.();
    return n;
  }

  // ---------- render helpers ----------
  private makeStars() {
    const rng = mulberry32(0x9e3779b1);
    const conf = [
      { n: 120, depth: 0.05, rmin: 0.3, rmax: 0.75, a: 0.34 },
      { n: 70, depth: 0.13, rmin: 0.5, rmax: 1.15, a: 0.5 },
      { n: 28, depth: 0.24, rmin: 0.75, rmax: 1.7, a: 0.72 },
    ];
    this.stars = conf.map((c) => ({
      depth: c.depth,
      a: c.a,
      pts: Array.from({ length: c.n }, () => ({
        x: rng(),
        y: rng(),
        r: c.rmin + rng() * (c.rmax - c.rmin),
        ph: rng() * 6.283,
        sp: 0.4 + rng() * 1.1,
        warm: rng() < 0.14,
      })),
    }));
  }
  private drawStars() {
    const ctx = this.ctx;
    const W = this.W;
    const H = this.H;
    if (!this.stars || !W) return;
    const t = this.tms * 0.001;
    const still = !this.ambient || this.reduced;
    for (const layer of this.stars) {
      let ox = (this.cam.tx * layer.depth) % W;
      if (ox < 0) ox += W;
      let oy = (this.cam.ty * layer.depth) % H;
      if (oy < 0) oy += H;
      for (const p of layer.pts) {
        const x = (p.x * W + ox) % W;
        const y = (p.y * H + oy) % H;
        const tw = still ? 0.85 : 0.6 + 0.4 * Math.sin(t * p.sp + p.ph);
        ctx.globalAlpha = layer.a * tw;
        ctx.fillStyle = p.warm ? "#FFE7CC" : "#D6E6FF";
        ctx.beginPath();
        ctx.arc(x, y, p.r, 0, 7);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
  private drawGraticule() {
    if (!this.grid) return;
    const ctx = this.ctx;
    const s = this.cam.scale;
    const cx = this.cam.tx;
    const cy = this.cam.ty;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(155,175,215,.05)";
    for (let r = 90; r <= 540; r += 90) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * s, 0, 7);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(155,175,215,.028)";
    for (let i = 0; i < 12; i++) {
      const a = i * 30 * DEG;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * 90 * s, cy + Math.sin(a) * 90 * s);
      ctx.lineTo(cx + Math.cos(a) * 540 * s, cy + Math.sin(a) * 540 * s);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(155,175,215,.075)";
    for (let i = 0; i < 72; i++) {
      const a = i * 5 * DEG;
      const r0 = 540 * s;
      const r1 = r0 + (i % 6 === 0 ? 7 : 3);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    }
  }
  private rgba(hex: string, a: number) {
    return rgbaHex(hex, a);
  }
  glowSprite = (hex: string): HTMLCanvasElement => {
    if (this._gs[hex]) return this._gs[hex];
    const s = 64;
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const x = c.getContext("2d")!;
    const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    const rgb = rgbOf(hex);
    g.addColorStop(0, `rgba(${rgb},0.95)`);
    g.addColorStop(0.32, `rgba(${rgb},0.42)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    x.fillStyle = g;
    x.fillRect(0, 0, s, s);
    this._gs[hex] = c;
    return c;
  };
  private areaHue(n: SimNode): string {
    if (this.colorMode === "mono") return STRUCT;
    return n.area ? (AREA[n.area]?.hue ?? STRUCT) : STRUCT;
  }
  private colorOf(n: SimNode): string {
    const base = this.areaHue(n);
    if (n.orphan) return mix(base, "#2C3140", 0.55);
    if (n.kind === "hub") return mix(base, ICE, 0.42);
    return mix(base, "#ffffff", n.tint || 0);
  }
  private drawFog() {
    if (!this.settings.fog || !this.fctx) return;
    const f = this.fogCv!;
    const fx = this.fctx;
    const FS = this.FS;
    fx.setTransform(1, 0, 0, 1, 0, 0);
    fx.clearRect(0, 0, f.width, f.height);
    fx.globalCompositeOperation = "lighter";
    const zf = Math.pow(this.cam.scale, 0.9);
    for (const n of this.nodes) {
      if (!this.visible(n) || n.orphan) continue;
      const sc = this.toScreen(n);
      if (sc.x < -140 || sc.x > this.W + 140 || sc.y < -140 || sc.y > this.H + 140) continue;
      const base = n.kind === "hub" ? 58 : n.minor ? 20 : 30 + Math.min(24, n.degree * 5);
      const size = (base * zf) / FS;
      fx.globalAlpha = n.kind === "hub" ? 0.13 : n.minor ? 0.05 : 0.08;
      fx.drawImage(this.glowSprite(this.areaHue(n)), sc.x / FS - size, sc.y / FS - size, size * 2, size * 2);
    }
    fx.globalAlpha = 1;
    fx.globalCompositeOperation = "source-over";
    const ctx = this.ctx;
    ctx.save();
    // DC literal is 0.85; nudged down slightly after live QA, so the nebula glow is
    // a little less overpowering, while keeping every per-node-kind ratio
    // (hub/minor/plain alpha, size formula) untouched.
    ctx.globalAlpha = 0.85; // DC literal - the nebula IS the galaxy's connective tissue, don't dim it
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(f, 0, 0, this.W, this.H);
    ctx.restore();
  }
  private edgeCtrl(sa: { x: number; y: number }, sb: { x: number; y: number }, e: SimEdge) {
    const mx = (sa.x + sb.x) / 2;
    const my = (sa.y + sb.y) / 2;
    const dx = sb.x - sa.x;
    const dy = sb.y - sa.y;
    const d = Math.hypot(dx, dy) || 1;
    const off = d * e.bow;
    return { x: mx - (dy / d) * off, y: my + (dx / d) * off };
  }
  private pathEdge(sa: { x: number; y: number }, sb: { x: number; y: number }, e: SimEdge) {
    const c = this.edgeCtrl(sa, sb, e);
    this.ctx.moveTo(sa.x, sa.y);
    this.ctx.quadraticCurveTo(c.x, c.y, sb.x, sb.y);
  }
  private quadPoint(sa: { x: number; y: number }, sb: { x: number; y: number }, e: SimEdge, t: number) {
    const c = this.edgeCtrl(sa, sb, e);
    const u = 1 - t;
    return {
      x: u * u * sa.x + 2 * u * t * c.x + t * t * sb.x,
      y: u * u * sa.y + 2 * u * t * c.y + t * t * sb.y,
    };
  }

  private loop = (ts: number) => {
    // Don't re-arm while hidden - onVis cancels, but a frame already queued when we
    // hid would otherwise re-request and keep the loop alive in the background.
    if (document.hidden) {
      this._raf = 0;
      return;
    }
    this._raf = requestAnimationFrame(this.loop);
    this.tms = ts;
    try {
      this.tick();
      this.updateAgents(ts);
      this.stepCamera();
      this.ambientTick(ts);
      this.draw();
      this._rf = (this._rf || 0) + 1;
      if (this.cfg.onReadout && this._rf % 9 === 0) {
        const w = this.toWorld(this.W / 2, this.H / 2);
        const ra = (((w.x % 720) + 720) % 720) / 30;
        const raH = Math.floor(ra);
        const raM = Math.floor((ra - raH) * 60);
        const dec = Math.max(-89, Math.min(89, -w.y / 6));
        const dd = Math.floor(Math.abs(dec));
        const dm = Math.floor((Math.abs(dec) - dd) * 60);
        this.cfg.onReadout(
          "α " +
            String(raH).padStart(2, "0") +
            "h" +
            String(raM).padStart(2, "0") +
            "m · δ " +
            (dec < 0 ? "−" : "+") +
            String(dd).padStart(2, "0") +
            "°" +
            String(dm).padStart(2, "0") +
            "′ · ×" +
            this.cam.scale.toFixed(2),
        );
      }
    } catch (e) {
      if (!this._logged) {
        this._logged = true;
        console.error("[galaxy]", e);
      }
    }
  };

  private draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    const { W, H, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this.drawStars();
    this.drawGraticule();
    this.drawFog();
    const s = this.settings;
    const accent = this.accent;
    const active = this.hovered || this.selected;
    const actNode = active ? this.byId.get(active) : null;
    let focus: Set<string> | null = null;
    let hotDep: Set<string> | null = null;
    if (active) {
      focus = new Set([active, ...(this.adj.get(active) || [])]);
      if (actNode) {
        // Any node that sits on a real dependency chain lights that chain up -
        // the DC gated this to tasks, but the vault now carries hand-authored
        // `depends:` edges on notes too, and those are exactly what the chain
        // treatment is for. depChain returns just {active} when no dep edges.
        // Memoized per active id: recomputing the walk every frame was pure
        // per-frame waste while hovering (2026-07-10 click-perf pass).
        const chain = this.depChainCached(active);
        if (chain.size > 1) {
          hotDep = chain;
          hotDep.forEach((id) => focus!.add(id));
        }
      }
    }
    const breathe = !this.ambient || this.reduced ? 1 : 1 + 0.05 * Math.sin(this.tms * 0.0013);
    const zoom = this.cam.scale;

    // ---- edges: functional links only, gently curved ----
    for (const e of this.edges) {
      const A = this.byId.get(e.source);
      const B = this.byId.get(e.target);
      if (!A || !B || !this.visible(A) || !this.visible(B)) continue;
      const inc = active && (e.source === active || e.target === active);
      if (e.kind === "member" && !inc) continue;
      const sa = this.toScreen(A);
      const sb = this.toScreen(B);
      if (
        (sa.x < -80 && sb.x < -80) ||
        (sa.x > W + 80 && sb.x > W + 80) ||
        (sa.y < -80 && sb.y < -80) ||
        (sa.y > H + 80 && sb.y > H + 80)
      )
        continue;
      const depHot = hotDep && e.kind === "dep" && hotDep.has(e.source) && hotDep.has(e.target);
      const isDepLike = e.kind === "dep" || e.kind === "wlink";
      let col: string | CanvasGradient;
      let w: number;
      if (e.kind === "member") {
        col = this.rgba(this.areaHue(A), 0.15);
        w = 0.55;
      } else if (inc || depHot) {
        col = this.rgba(accent, depHot ? 0.9 : 0.72);
        w = depHot ? 1.5 : 1.15;
      } else if (active) {
        col = "rgba(125,145,190,0.045)";
        w = 0.5;
      } else if (e.kind === "dep") {
        col = this.rgba("#93A9DC", 0.27 * s.linkOpacity);
        w = 0.75;
      } else if (e.kind === "wlink") {
        // wikilink-derived dependency-shaped edge - same family hue as a real `dep` but
        // quieter, so the vault's now-much-larger dependency graph reads as directional
        // structure without drowning out the sparse hand-authored `dep` edges (2026-07-05).
        col = this.rgba("#93A9DC", 0.16 * s.linkOpacity);
        w = 0.6;
      } else if (e.cross) {
        const g = ctx.createLinearGradient(sa.x, sa.y, sb.x, sb.y);
        g.addColorStop(0, this.rgba(this.areaHue(A), 0.22 * s.linkOpacity));
        g.addColorStop(1, this.rgba(this.areaHue(B), 0.22 * s.linkOpacity));
        col = g;
        w = 0.7;
      } else {
        col = this.rgba(this.areaHue(A), 0.15 * s.linkOpacity);
        w = 0.6;
      }
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      const bp = e.bornAt ? Math.min(1, (this.tms - e.bornAt) / 1100) : 1;
      ctx.beginPath();
      if (bp < 1) {
        const pe = bp * bp * (3 - 2 * bp);
        const cc = this.edgeCtrl(sa, sb, e);
        const q1 = { x: sa.x + (cc.x - sa.x) * pe, y: sa.y + (cc.y - sa.y) * pe };
        const q2 = this.quadPoint(sa, sb, e, pe);
        ctx.moveTo(sa.x, sa.y);
        ctx.quadraticCurveTo(q1.x, q1.y, q2.x, q2.y);
      } else this.pathEdge(sa, sb, e);
      ctx.stroke();
      // DEPENDENCY MOTION (restored readable 2026-07-10): the marching-dash flow is reserved for
      // dependency-shaped edges on hover/focus - hand-authored `depends:` (+ blockedBy/
      // upstream/blocks/downstream) get the bright treatment, `wlink` (wikilink-derived) a
      // quieter one. Restored to glance-readable: ~11px marks at ~60px/s screen space (period
      // 24px ≈ 3-5 marks on a typical link), wlink slightly smaller/slower. Do not shrink these
      // below ~8px or ~40px/s - that is the regression.
      if ((inc || depHot) && isDepLike && !this.reduced) {
        ctx.save();
        const wlinkHover = e.kind === "wlink";
        ctx.strokeStyle = wlinkHover ? this.rgba(accent, 0.6) : this.rgba(accent, 0.9);
        ctx.lineWidth = wlinkHover ? 1.4 : 1.8;
        ctx.setLineDash(wlinkHover ? [8, 16] : [11, 13]);
        ctx.lineDashOffset = -this.tms * (wlinkHover ? 0.042 : 0.06); // readable flow along the dependency
        ctx.beginPath();
        this.pathEdge(sa, sb, e);
        ctx.stroke();
        ctx.restore();
      }
      if (s.arrows && isDepLike) {
        const hot = inc || depHot;
        const c = this.edgeCtrl(sa, sb, e);
        const ang = Math.atan2(sb.y - c.y, sb.x - c.x);
        const br = this.screenR(B) + 2.5;
        const ax = sb.x - Math.cos(ang) * br;
        const ay = sb.y - Math.sin(ang) * br;
        const restAlpha = e.kind === "dep" ? 0.42 : 0.22; // wlink sits quieter at rest
        // Hot (hovered/on-chain) arrowheads sized to read at a glance alongside the restored
        // dash flow; REST sizes stay the approved always-on subtlety - don't touch those.
        const al = hot ? (e.kind === "dep" ? 7 : 5.5) : e.kind === "dep" ? 3.2 : 2.4;
        ctx.fillStyle = hot ? this.rgba(accent, 0.9) : this.rgba("#93A9DC", restAlpha * s.linkOpacity);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax - Math.cos(ang - 0.42) * al, ay - Math.sin(ang - 0.42) * al);
        ctx.lineTo(ax - Math.cos(ang + 0.42) * al, ay - Math.sin(ang + 0.42) * al);
        ctx.closePath();
        ctx.fill();
      }
      if (depHot && !this.reduced) {
        const pp = (this.tms * 0.0004) % 1;
        const q = this.quadPoint(sa, sb, e, pp);
        ctx.fillStyle = this.rgba(accent, 0.95);
        ctx.beginPath();
        ctx.arc(q.x, q.y, 2.4, 0, 7); // chain pulse - sized up with the restored dash flow
        ctx.fill();
      }
    }

    // ---- glow pass ----
    ctx.globalCompositeOperation = "lighter";
    for (const n of this.nodes) {
      if (!this.visible(n)) continue;
      const sc = this.toScreen(n);
      if (sc.x < -50 || sc.x > W + 50 || sc.y < -50 || sc.y > H + 50) continue;
      const isAct = n.id === active;
      const inF = !focus || focus.has(n.id);
      if (!inF) continue;
      let r = this.screenR(n);
      if (n.bornAt) {
        const bp = Math.min(1, (this.tms - n.bornAt) / 900);
        r *= bp * bp * (3 - 2 * bp);
      }
      let hue = this.colorOf(n);
      if (this.liveNodes.has(n.id) && !active) hue = mix(hue, accent, 0.26);
      if (isAct) hue = accent;
      const strength = n.kind === "hub" ? 0.4 : isAct ? 0.62 : n.minor ? 0.13 : 0.2;
      const k = n.kind === "hub" ? 5.6 : isAct ? 7.5 : n.minor ? 2.8 : 3.8;
      const size = Math.max(5, r * k);
      ctx.globalAlpha = strength * breathe;
      ctx.drawImage(this.glowSprite(isAct ? accent : hue), sc.x - size, sc.y - size, size * 2, size * 2);
    }
    // traffic beads
    for (const p of this.traffic) {
      const A = this.byId.get(p.from);
      const B = this.byId.get(p.to);
      if (!A || !B || !this.visible(A) || !this.visible(B)) continue;
      const e = this.edgeMap.get(p.from + "|" + p.to);
      let t = (this.tms - p.t0) / p.dur;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const te = t * t * (3 - 2 * t);
      let q: { x: number; y: number };
      if (e) {
        const SA = this.toScreen(this.byId.get(e.source)!);
        const SB = this.toScreen(this.byId.get(e.target)!);
        q = this.quadPoint(SA, SB, e, e.source === p.from ? te : 1 - te);
      } else {
        const sa = this.toScreen(A);
        const sb = this.toScreen(B);
        q = { x: sa.x + (sb.x - sa.x) * te, y: sa.y + (sb.y - sa.y) * te };
      }
      ctx.globalAlpha = 0.85;
      ctx.drawImage(this.glowSprite(p.write ? accent : "#8FB4FF"), q.x - 6, q.y - 6, 12, 12);
      ctx.globalAlpha = 1;
      ctx.fillStyle = p.write ? "#FFD9CF" : "#DCE9FF";
      ctx.beginPath();
      ctx.arc(q.x, q.y, 1.7, 0, 7);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    // arrival flashes
    for (const fl of this.flashes) {
      const n = this.byId.get(fl.id);
      if (!n || !this.visible(n)) continue;
      const sc = this.toScreen(n);
      const age = (this.tms - fl.t0) / 520;
      ctx.globalAlpha = (1 - age) * 0.55;
      ctx.strokeStyle = fl.hue;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sc.x, sc.y, Math.max(0.1, this.screenR(n) + 2 + age * 11), 0, 7);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // ---- crisp star cores + labels ----
    // Label collision culling: at the DC sample's density (≈215 artifacts) the approved
    // gates never overlap, so this changes NOTHING about the approved look - but the real
    // vault packs 300+ nodes into one cluster, where the same faithful gates would stack
    // a wall of overlapping serif labels in the core. Greedy screen-rect dedup: a leaf
    // label is skipped this frame if it would land on one already drawn. Hubs and
    // selected/focused labels always win (they claim their rects first by loop order -
    // hubs draw regardless, and `near` labels bypass the cull below).
    const placedLabels: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const labelCollides = (x1: number, y1: number, x2: number, y2: number): boolean => {
      for (const p of placedLabels) {
        if (x1 < p.x2 && x2 > p.x1 && y1 < p.y2 && y2 > p.y1) return true;
      }
      return false;
    };
    for (const n of this.nodes) {
      if (!this.visible(n)) continue;
      const sc = this.toScreen(n);
      if (sc.x < -50 || sc.x > W + 50 || sc.y < -50 || sc.y > H + 50) continue;
      const isAct = n.id === active;
      const inF = !focus || focus.has(n.id);
      let r = this.screenR(n) * (isAct ? 1.3 : 1);
      if (n.bornAt) {
        const bp = Math.min(1, (this.tms - n.bornAt) / 900);
        r = Math.max(0.2, r * (bp * bp * (3 - 2 * bp)));
      }
      let col = this.colorOf(n);
      if (this.liveNodes.has(n.id) && !active) col = mix(col, accent, 0.22);
      if (isAct) col = accent;
      ctx.globalAlpha = inF ? 1 : 0.13;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(sc.x, sc.y, r, 0, 7);
      ctx.fill();
      if (n.kind === "hub" || isAct) {
        ctx.lineWidth = Math.max(0.6, r * 0.15);
        ctx.strokeStyle = isAct ? "#fff" : mix(col, "#ffffff", 0.55);
        ctx.beginPath();
        ctx.arc(sc.x, sc.y, r + (isAct ? 1.4 : 0.7), 0, 7);
        ctx.stroke();
      }
      if (this.liveNodes.has(n.id) && !isAct && inF) {
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = this.rgba(accent, 0.3 + 0.18 * Math.sin(this.tms * 0.002 + r));
        ctx.beginPath();
        ctx.arc(sc.x, sc.y, r + 2.6, 0, 7);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      if (!s.labels || !inF) continue;
      const isHub = n.kind === "hub";
      const near =
        isAct ||
        (!!active &&
          !!focus &&
          focus.has(n.id) &&
          (focus.size <= 14 || n.type === "task" || (hotDep != null && hotDep.has(n.id))));
      // LOD thresholds: the DC's literal values, EXACTLY (task > 1.05, plain > 2.4, minor >
      // 2.8). Faithful port per the 2026-07-03 design review, which found the first port too
      // far off - do NOT re-raise these preemptively; density tweaks come from a visual review.
      // Task gate 0.9 (DC literal was 1.05): the DC sample's ~215-node world fit at ×1.6 where
      // 1.05 kept labels on at overview; the real 950-node world fits at ×1.0, which sat right
      // ON the 1.05 gate - labels flickered out at fit-to-view, contradicting the approved
      // screenshots. 0.9 keeps the approved "labels visible at overview" behavior at production
      // scale; the collision cull (placedLabels) is what prevents the wall.
      const show = isHub
        ? zoom > 0.5
        : near
          ? true
          : n.minor
            ? zoom > 2.8
            : n.type === "task"
              ? zoom > 0.9
              : zoom > 2.4;
      if (!show) continue;
      let font: string;
      let txt = n.label;
      let fill: string;
      if (isHub) {
        font = "600 10px " + MONO;
        txt = n.label.toUpperCase();
        fill = this.rgba(mix(this.colorOf(n), ICE, 0.5), isAct ? 1 : 0.85);
      } else if (n.type === "task") {
        font = "600 11px " + SERIF;
        fill = this.rgba("#D9E1F2", isAct ? 1 : near ? 0.95 : 0.8);
      } else if (n.type === "idea") {
        font = "italic 600 11px " + SERIF;
        fill = this.rgba("#CBD5EA", near ? 0.95 : 0.75);
      } else if (n.type === "conversation") {
        font = "italic 500 10.5px " + SERIF;
        fill = this.rgba("#AAB5CC", near ? 0.92 : 0.7);
      } else if (n.minor) {
        font = "400 9px " + MONO;
        fill = this.rgba("#7D8699", near ? 0.9 : 0.55);
      } else {
        font = (n.type === "reference" ? "italic " : "") + "500 9.5px " + MONO;
        fill = this.rgba("#9AA5BD", near ? 0.92 : 0.72);
      }
      ctx.font = font;
      // Collision cull (see placedLabels above): plain leaf labels yield to whatever's
      // already drawn; hubs and near/selected labels always render AND claim their rect
      // so lower-priority neighbors flow around them.
      const labelW = ctx.measureText(txt).width;
      const lx1 = sc.x - labelW / 2 - 2;
      const ly1 = sc.y + r + 3;
      const lx2 = sc.x + labelW / 2 + 2;
      const ly2 = ly1 + 13;
      if (!isHub && !near && labelCollides(lx1, ly1, lx2, ly2)) continue;
      placedLabels.push({ x1: lx1, y1: ly1, x2: lx2, y2: ly2 });
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = fill;
      ctx.shadowColor = "rgba(2,3,8,.8)";
      ctx.shadowBlur = 4;
      if (isHub) {
        try {
          (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "2px";
        } catch {
          /* letterSpacing unsupported */
        }
      }
      ctx.fillText(txt, sc.x, sc.y + r + 4);
      if (isHub) {
        try {
          (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = "0px";
        } catch {
          /* letterSpacing unsupported */
        }
      }
      ctx.shadowBlur = 0;
    }

    // ---- agent bodies ----
    drawAgents(
      {
        ctx,
        tms: this.tms,
        reduced: this.reduced,
        ambient: this.ambient,
        accent: this.accent,
        cam: this.cam,
        agents: this.agents,
        agentBodies: this.agentBodies,
        byId: this.byId,
        visible: (n) => this.visible(n),
        toScreen: this.toScreen,
        screenR: this.screenR,
        glowSprite: this.glowSprite,
      },
      zoom,
      W,
      H,
    );

    // ---- selection reticle: astrolabe ring ----
    if (actNode && this.visible(actNode)) {
      const sc = this.toScreen(actNode);
      const rr = this.screenR(actNode) * 1.3 + 9;
      ctx.strokeStyle = this.rgba(accent, 0.8);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sc.x, sc.y, rr, 0, 7);
      ctx.stroke();
      for (let q = 0; q < 4; q++) {
        const a = q * 1.5708;
        ctx.beginPath();
        ctx.moveTo(sc.x + Math.cos(a) * (rr + 2), sc.y + Math.sin(a) * (rr + 2));
        ctx.lineTo(sc.x + Math.cos(a) * (rr + 7), sc.y + Math.sin(a) * (rr + 7));
        ctx.stroke();
      }
      const rot = this.reduced ? 0 : this.tms * 0.0005;
      ctx.save();
      ctx.translate(sc.x, sc.y);
      ctx.rotate(rot);
      ctx.strokeStyle = this.rgba(accent, 0.32);
      ctx.lineWidth = 0.8;
      ctx.setLineDash([2, 8]);
      ctx.beginPath();
      ctx.arc(0, 0, rr + 12, 0, 7);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
}

const SERIF = "'Spectral', Georgia, serif";
const MONO = "'IBM Plex Mono', ui-monospace, monospace";
