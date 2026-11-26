/**
 * framings - the finite set of composed camera states (round3-remodel-lock R2/R4).
 *
 * R2: the camera NEVER orbits. There is exactly ONE view direction - straight-on
 * +Z with a fixed ~12° downward tilt for depth. Navigation is pan (truck XY) +
 * clamped dolly only, so a framing is just {lookAt, dist}: no azimuth/polar
 * windows exist anymore.
 *
 * R4: two canonical compositions - OVERVIEW (brain + all 5 medallions + the
 * first milestone ring, no zooming required) and AREA FOCUS (one sector fills
 * the frame with its milestone chain). Both are derived deterministically from
 * the graph layout, so they stay correct if the layout tunables move.
 */

import * as THREE from "three";
import { buildGraph, type Graph } from "@/data/graph";
import { computeJourneyTargets, journeySlotX } from "@/data/journeyLayout";
import { AUTHORED_MILESTONES, type JourneyMilestone } from "@/data/journey";

export interface Framing {
  /** Area id, or null for the overview. */
  id: string | null;
  /** Composed look-at center (sector midpoint for areas). */
  lookAt: THREE.Vector3;
  /** Camera distance from lookAt along VIEW_DIR. */
  dist: number;
  /** Allowed dolly range as multiples of `dist` (a narrow zoom band). */
  distWindow: [number, number];
}

/** THE one fixed view direction (lookAt → camera). ~12° downward tilt. */
export const VIEW_TILT = THREE.MathUtils.degToRad(12);
export const VIEW_DIR = new THREE.Vector3(0, Math.sin(VIEW_TILT), Math.cos(VIEW_TILT));

/** The pinned camera-controls angles that realize VIEW_DIR (min = max = these). */
export const AZIMUTH_PIN = 0;
export const POLAR_PIN = Math.PI / 2 - VIEW_TILT;

/** Global hard bounds - the camera can NEVER leave these (no black screens). */
export const MIN_DIST = 8;
export const MAX_DIST = 150;
export const OVERVIEW_DIST = 64;

/** Truck boundary for the target, derived from both live map compositions. */
const boundaryGraph = buildGraph();
const boundaryTargets = computeJourneyTargets(boundaryGraph, AUTHORED_MILESTONES);
let journeyMinX = -44;
let journeyMaxX = 44;
let journeyMinY = -38;
let journeyMaxY = 38;
for (const [id, p] of boundaryTargets) {
  if (id.startsWith("__")) continue;
  journeyMinX = Math.min(journeyMinX, p[0]);
  journeyMaxX = Math.max(journeyMaxX, p[0]);
  journeyMinY = Math.min(journeyMinY, p[1]);
  journeyMaxY = Math.max(journeyMaxY, p[1]);
}
export const BOUNDS = new THREE.Box3(
  new THREE.Vector3(journeyMinX - 8, journeyMinY - 8, -13),
  new THREE.Vector3(journeyMaxX + 8, journeyMaxY + 8, 8),
);

export const OVERVIEW_FRAMING: Framing = {
  id: null,
  lookAt: new THREE.Vector3(0, 0, 0),
  dist: OVERVIEW_DIST,
  distWindow: [34 / OVERVIEW_DIST, MAX_DIST / OVERVIEW_DIST],
};

/**
 * The JOURNEY roadmap framing - the DAG spans wide on x (past left, future right,
 * centred a touch right of NOW), so we look a little right of origin and pull back
 * to fit it. Distinct from the brain overview so the roadmap reads at full width.
 */
// The journey framing is COMPUTED from the actual left-root DAG bbox (it grows
// right with the longest dependency chain), so the whole roadmap always fits no
// matter how many ranks the data produces - same auto-fit discipline as clusters.
let _jframe: Framing | null = null;
export function journeyFraming(): Framing {
  if (_jframe) return _jframe;
  const g = buildGraph();
  const targets = computeJourneyTargets(g, AUTHORED_MILESTONES);
  // the milestone roadmap is the content; the hub and the faded area medallions
  // (which tuck off the far-left edge) must NOT stretch the overview's fit.
  const skipIds = new Set<string>(["hub", ...g.nodes.filter((n) => n.tier === 1).map((n) => n.id)]);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [id, p] of targets) {
    if (id.startsWith("__")) continue;
    if (skipIds.has(id)) continue; // hub + faded medallions aren't framed content
    if (/\.d\d+$/.test(id)) continue; // artifact comb leaves unfold on zoom - don't frame them
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  if (!isFinite(minX)) {
    _jframe = { id: null, lookAt: new THREE.Vector3(28, 0, -2), dist: 62, distWindow: [0.5, 1.3] };
    return _jframe;
  }
  const fovHalf = THREE.MathUtils.degToRad(50 / 2);
  // Usable content aspect: reserve the permanent inspector and tool rail.
  const ASPECT = 1.4;
  const FILL = 0.82;
  const PAD_X = 6;
  const PAD_TOP = 4.5; // room for the milestone labels that ride above their nodes
  const PAD_BOT = 6.5; // room for the status tag + the top of each artifact comb
  minX -= PAD_X; maxX += PAD_X; minY -= PAD_BOT; maxY += PAD_TOP;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const halfW = (maxX - minX) / 2;
  const halfH = (maxY - minY) / 2;
  const distV = halfH / (Math.tan(fovHalf) * FILL);
  const distH = halfW / (Math.tan(fovHalf) * ASPECT * FILL);
  const dist = THREE.MathUtils.clamp(Math.max(distV, distH), 30, MAX_DIST);
  _jframe = { id: null, lookAt: new THREE.Vector3(cx, cy, -2), dist, distWindow: [0.5, 1.25] };
  return _jframe;
}

/** Back-compat constant (some call sites read it directly). */
export const JOURNEY_FRAMING: Framing = journeyFraming();

const FOV_HALF = THREE.MathUtils.degToRad(50 / 2); // BrainCanvas camera fov

/** Milestone-only Y bounds of the roadmap (artifact combs excluded so the time
 *  slab stays tight and trucking reads as motion). */
function laneYBounds(targets: Map<string, [number, number, number]>): [number, number] {
  let minY = Infinity, maxY = -Infinity;
  for (const [id, p] of targets) {
    if (id === "hub") continue;
    if (/\.d\d+$/.test(id)) continue; // skip artifact comb leaves
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  if (!isFinite(minY)) return [-18, 18];
  return [minY, maxY];
}

/**
 * TIME-SCRUB framing - the ←/→ verb. Centers the camera on a time slot while
 * keeping the FULL vertical stack of lanes in frame, so pressing → trucks the
 * "now line" forward through the whole roadmap (past → now → future). Height-fit
 * (not width-fit) so horizontal motion between slots is actually visible. `col`
 * is a signed time slot (negative = past, 0 = NOW/core, positive = future).
 */
export function journeyTimeFraming(g: Graph, milestones: JourneyMilestone[], col: number): Framing {
  const targets = computeJourneyTargets(g, milestones);
  let [minY, maxY] = laneYBounds(targets);
  const PAD_TOP = 4.5; // milestone labels ride above their nodes
  const PAD_BOT = 5.0; // status tag + a peek of the artifact comb below
  minY -= PAD_BOT;
  maxY += PAD_TOP;
  const cy = (minY + maxY) / 2;
  const halfH = Math.max(7, (maxY - minY) / 2);
  const FILL = 0.92;
  const dist = THREE.MathUtils.clamp(halfH / (Math.tan(FOV_HALF) * FILL), 22, MAX_DIST);
  return { id: null, lookAt: new THREE.Vector3(journeySlotX(col), cy, -2), dist, distWindow: [0.5, 1.25] };
}

/**
 * LANE framing - the ↑/↓ "switch area" verb. Frames one initiative's whole lane
 * (its milestones + their artifact combs) so the chosen area fills the frame, a
 * Google-Maps sideways glide between lanes.
 */
export function journeyLaneFraming(g: Graph, milestones: JourneyMilestone[], areaId: string): Framing {
  const targets = computeJourneyTargets(g, milestones);
  const lane = new Set(milestones.filter((m) => m.areaId === areaId).map((m) => m.id));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const node of g.nodes) {
    const inLane = lane.has(node.id) || (node.parentId != null && lane.has(node.parentId));
    if (!inLane) continue;
    const p = targets.get(node.id);
    if (!p) continue;
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  if (!isFinite(minX)) return journeyTimeFraming(g, milestones, 0);
  const PAD_X = 5, PAD_TOP = 4, PAD_BOT = 3;
  minX -= PAD_X; maxX += PAD_X; minY -= PAD_BOT; maxY += PAD_TOP;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const ASPECT = 1.5;
  const FILL = 0.86;
  const distV = (maxY - minY) / 2 / (Math.tan(FOV_HALF) * FILL);
  const distH = (maxX - minX) / 2 / (Math.tan(FOV_HALF) * ASPECT * FILL);
  const dist = THREE.MathUtils.clamp(Math.max(distV, distH), 20, MAX_DIST);
  return { id: areaId, lookAt: new THREE.Vector3(cx, cy, -2), dist, distWindow: [0.5, 1.35] };
}

let _cache: Map<string, Framing> | null = null;

/**
 * One composed AREA-FOCUS framing per area (keyed by area id). AUTO-FIT: we take
 * the real 2D bounding box of the cluster's WHOLE subtree (medallion + tasks +
 * detail leaves), pad it for labels, and size the distance to fit BOTH width and
 * height - so the focused cluster fills the frame as a balanced tree and nothing
 * is ever cut off (the old radial-extent guess overflowed long sliver subtrees).
 * lookAt = the subtree's bbox centre (which sits out on the sector, not the core).
 */
export function clusterFramings(): Map<string, Framing> {
  if (_cache) return _cache;
  const g = buildGraph();
  const map = new Map<string, Framing>();
  const fovHalf = THREE.MathUtils.degToRad(50 / 2); // BrainCanvas camera fov
  // assume a slightly-narrow aspect when fitting so the tree never overflows on
  // narrower windows; FILL leaves a clean margin; PAD is world-space label room
  const ASPECT = 1.45;
  const FILL = 0.84;
  const PAD = 3.6;
  for (const n of g.nodes) {
    if (n.tier !== 1) continue;
    // every node that rolls up to this area (medallion + tasks + detail leaves)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let zSum = 0, count = 0;
    for (const m of g.nodes) {
      if (m.areaId !== n.id) continue;
      minX = Math.min(minX, m.pos[0]); maxX = Math.max(maxX, m.pos[0]);
      minY = Math.min(minY, m.pos[1]); maxY = Math.max(maxY, m.pos[1]);
      zSum += m.pos[2]; count++;
    }
    if (count === 0) continue;
    // include the medallion itself (tier-1 node is in the loop above via areaId)
    minX -= PAD; maxX += PAD; minY -= PAD; maxY += PAD;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const midZ = zSum / count;
    const halfW = (maxX - minX) / 2;
    const halfH = (maxY - minY) / 2;
    // fit both axes: vertical by fov, horizontal by fov*aspect; take the tighter
    const distV = halfH / (Math.tan(fovHalf) * FILL);
    const distH = halfW / (Math.tan(fovHalf) * ASPECT * FILL);
    const dist = THREE.MathUtils.clamp(Math.max(distV, distH), 20, 56);
    map.set(n.id, {
      id: n.id,
      lookAt: new THREE.Vector3(cx, cy, midZ),
      dist,
      // a roomy arrival band: you can dolly in to read the detail leaves, or ease
      // out a touch, without snapping back to the overview
      distWindow: [0.5, 1.4],
    });
  }
  _cache = map;
  return map;
}

/** Area ids in graph order - number keys 1–5 jump to these. */
export function areaOrder(): string[] {
  return buildGraph()
    .nodes.filter((n) => n.tier === 1)
    .map((n) => n.id);
}
