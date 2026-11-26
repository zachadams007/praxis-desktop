/**
 * engineTypes.ts - the RUNTIME shapes the canvas engine mutates in place (positions,
 * velocities, live animation state). Distinct from the serializable GraphData in types.ts:
 * these carry per-frame mutable fields the force sim + draw loop write every frame, and are
 * kept imperative (never React state) per the architecture note.
 */
import type { AreaId, ArtifactKind } from "./types";

/** A simulated node - a star in the galaxy. */
export interface SimNode {
  id: string;
  label: string;
  kind: "hub" | "leaf";
  type?: ArtifactKind;
  area: AreaId;
  minor: boolean;
  orphan: boolean;
  live?: boolean;
  prog?: number;
  degree: number;
  description?: string;
  meta?: string;
  slug?: string;
  /** small per-node brightness jitter (0..~0.18) so a cluster isn't flat. */
  tint: number;
  /** radius in world units (semantic - set by nodeR). */
  r: number;
  // --- mutable sim state ---
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** pinned position (drag) - when set, the node holds. */
  fx?: number | null;
  fy?: number | null;
  /** member-edge degree (recomputed each tick) - spring impulses split d3-style by this,
   *  so a hub with hundreds of children doesn't become a stiff unstable oscillator. */
  md?: number;
  /** ms timestamp a live-born node/link started animating in (birth ease). */
  bornAt?: number;
}

/** A simulated edge. */
export interface SimEdge {
  source: string;
  target: string;
  kind: "member" | "link" | "wlink" | "dep";
  cross?: boolean;
  /** per-edge length jitter (real links). */
  jit: number;
  /** per-edge bow (curvature sign + magnitude). */
  bow: number;
  /** member-edge target length. */
  L: number;
  /** ms timestamp a live-woven edge started drawing in. */
  bornAt?: number;
}

/** A traffic bead (a real read/write travelling a real link). */
export interface Bead {
  from: string;
  to: string;
  t0: number;
  dur: number;
  write: boolean;
  tint: string;
  done?: boolean;
}

/** A ring-flash (commit / arrival). */
export interface Flash {
  id: string;
  t0: number;
  hue: string;
}

/** An agent op - a live read/write/link/create the rig is performing on a node. */
export interface AgentOp {
  type: "read" | "write" | "link" | "create";
  t0: number;
  dur: number;
  nodeId: string;
}

/** An agent body - the armillary rig roaming the vault. */
export interface AgentBody {
  x: number;
  y: number;
  nodeId: string;
  state: "travel" | "dwell";
  dwellUntil: number;
  ang: number;
  ph: number;
  ops: AgentOp[];
  flare: number;
  trail: Array<{ x: number; y: number; t: number }>;
  lastP: { x: number; y: number } | null;
  holdUntil: number;
}

/** A minimal agent descriptor the engine + rig need (a projection of AgentRow). */
export interface EngineAgent {
  id: string;
  name: string;
  /** model family token (opus/sonnet/haiku/hermes/codex/cursor/…) for tint + sigil. */
  fam: string;
  status: "working" | "idle" | "done";
  /** current focus: a node id OR a label the engine resolves to a node. */
  focus: string | null;
  prog: number;
  /** Is `prog` a real measurement? False for session-derived rows (no per-task
   *  percentage exists in fd_sessions) - the rig then draws no progress hairline
   *  rather than a constant one that reads as measured. */
  progKnown?: boolean;
  /** areas this agent touches (for the area-firing readout). */
  touches: string[];
}
