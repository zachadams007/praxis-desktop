/**
 *
 * The praxis brain is the MIDDLE node. Everything starts there for both past and
 * future; they grow as two mirrored trees off the core:
 *
 *   • The CORE is NOW (x = 0). The brain branches UP/DOWN to each major area
 *     (one area node per initiative, sitting on the NOW axis at its lane Y).
 *   • Each area is a FORK: its completed milestones branch out to the LEFT
 *     (the past tree), its active/upcoming milestones branch out to the RIGHT
 *     (the future tree), the newest/nearest closest to the core, the oldest/
 *     furthest-out at the tips. Same spacing both sides → symmetric left↔right.
 *   • Each milestone branches again to its ARTIFACTS (the smaller things) in a
 *     tidy comb cascading AWAY from NOW, so the detail layer reads as leaf-twigs
 *     at the overview and unfolds into a labelled list when you fly in.
 *   • The branches themselves are the structural hub→area→milestone→artifact
 *     edges (EdgeField shows them in journey now) drawn as the curved sweeping
 *     elbow connectors; cross-area dependencies arc faintly between trees.
 *
 * Areas stack top→bottom with a clear GAP around the core so the brain reads as
 * the central hub, not buried under a lane. Pure data + plain tuples,
 * three.js-free, deterministic. Returns Map<id, [x,y,z]> from computeJourneyTargets.
 */

import { CLUSTER_ORDER, TIER_Z, type Graph, type NodeTier } from "./graph";
import { STATUS_RANK, type JourneyMilestone, type MilestoneStatus } from "./journey";

export type V3 = [number, number, number];

// --- tunables (the single tuning surface) ---
/** The slot that reads as NOW - the core sits here, at the world origin. */
export const NOW_SLOT = 0;
const CORE_CLEAR = 17; // |x| of the first milestone each side of NOW (matches the original COL0_X)
const STEP_X = 10; // even horizontal spacing between milestones (matches the original)
const LANE_GAP = 8.5; // vertical spacing between initiative rows (even - matches the original)
const HUB_X = 0; // the core renders at the world origin - the "mind" at NOW

// artifact comb (hangs beneath each milestone - the organized detail branch).
// DETAIL_TOP leaves a clean band right under the node for the status/eta tag,
// so the comb's first leaf (and its label) never collide with it.
// It's a tidy DIAGONAL CASCADE stepping DOWN and OUTWARD (away from NOW): future
// milestones cascade down-and-right, past milestones down-and-left, so every leaf
// - and, crucially, its label - gets BOTH vertical and horizontal separation and
// opens away from the centre instead of piling onto the neighbour toward NOW.
const DETAIL_TOP = 2.9; // first artifact below the milestone node (clears the status tag)
const DETAIL_DY = 1.7; // vertical step down the cascade
const DETAIL_DX0 = 1.0; // first leaf's indent outward from the lane spine
const DETAIL_DX_STEP = 2.0; // extra outward step per leaf (the diagonal cascade)

const Z_PLANE = TIER_Z[2] * 0.5; // the roadmap sits on a calm, near-flat plane
const Z_DETAIL = TIER_Z[3] * 0.5; // artifacts a touch deeper for gentle parallax
const Z_PARALLAX = 0.25; // tiny seeded z jitter (life, not information)

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
const seed01 = (id: string) => mulberry32(hashStr(id))();

/** A milestone is "behind us" when done - used for the gentle completed lift. */
const isDone = (s?: MilestoneStatus) => s === "done";

// ---------------------------------------------------------------------------
// Shared axis helpers - the TIME axis (signed slot → x) and the AREA axis (y).
//
// These are the single source of truth for where a milestone lands, reused by
// both the layout above AND the journey navigation (time scrub / lane switch /
// task hop). Keeping them here means the camera flies to the exact coordinates
// the geometry uses, so ←/→ sweeps through time along the real roadmap.
//
// A milestone's signed SLOT is its position on the TIME axis relative to NOW:
//   done   → -1 … -d   (-1 = most recently finished, just behind NOW; -d = oldest)
//   active/next/later → +1 … +f  (+1 = nearest ahead / in-flight; +f = furthest out)
// There is no slot 0 milestone - slot 0 IS now (the core).
// ---------------------------------------------------------------------------

/**
 * |x| ≥ CORE_CLEAR, so nothing collides with the core despite the tight centre.
 */
export function journeyLaneY(areaId: string | undefined): number {
  const n = CLUSTER_ORDER.length;
  const i = areaId ? CLUSTER_ORDER.indexOf(areaId) : -1;
  const idx = i < 0 ? n : i;
  return -(idx - (n - 1) / 2) * LANE_GAP;
}

/** World X of a signed time slot. slot 0 = NOW (the core); past left, future right. */
export function journeySlotX(slot: number): number {
  if (slot === 0) return HUB_X;
  const dir = slot < 0 ? -1 : 1;
  const k = Math.abs(slot);
  return dir * (CORE_CLEAR + (k - 1) * STEP_X);
}

/**
 * Signed slot of every milestone WITHIN its lane: done streams negative (newest
 * nearest NOW), active/next/later stream positive (nearest ahead first). All
 * lanes share the NOW origin, so a given |slot| is the same distance from NOW in
 * every lane - the corridor is symmetric about the core.
 */
export function journeySlotIndex(milestones: JourneyMilestone[]): Map<string, number> {
  const slotOf = new Map<string, number>();
  for (const areaId of [...new Set(milestones.map((m) => m.areaId))]) {
    const lane = milestones
      .filter((m) => m.areaId === areaId)
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.order - b.order);
    const done = lane.filter((m) => m.status === "done");
    const ahead = lane.filter((m) => m.status !== "done");
    // done: oldest deepest (-d), most-recent just behind NOW (-1)
    done.forEach((m, i) => slotOf.set(m.id, -(done.length - i)));
    // ahead: active/nearest first (+1), far-future furthest (+f)
    ahead.forEach((m, i) => slotOf.set(m.id, i + 1));
  }
  return slotOf;
}

/** Most-negative slot in use - the deepest past edge of the time axis. */
export function journeyMinSlot(milestones: JourneyMilestone[]): number {
  let min = 0;
  for (const s of journeySlotIndex(milestones).values()) min = Math.min(min, s);
  return min;
}

/** Most-positive slot in use - the far-future edge of the time axis. */
export function journeyMaxSlot(milestones: JourneyMilestone[]): number {
  let max = 0;
  for (const s of journeySlotIndex(milestones).values()) max = Math.max(max, s);
  return max;
}

/** Populated initiative lanes, top → bottom (CLUSTER_ORDER order). */
export function journeyLanes(milestones: JourneyMilestone[]): string[] {
  const present = new Set(milestones.map((m) => m.areaId));
  return CLUSTER_ORDER.filter((id) => present.has(id));
}

/**
 * Compute the journey-mode position of every node: a BRAIN-ROOTED BRANCHING TREE
 * (the owner's locked Journey-Tree spec). The praxis brain is the single MIDDLE node
 * at the origin; each area sprouts a pair of branches straight off it - FUTURE
 * work fans to the RIGHT (active nearest the brain → later at the tip), PAST work
 * mirrors to the LEFT (newest-done nearest → oldest at the tip). The two sides
 * join ONLY through the brain. Branches converge toward the centre near NOW and
 * splay out to their band, so the whole thing reads as lines fanning OUT of the
 * brain - not stacked Gantt lanes. Artifacts comb beneath each milestone.
 */
export function computeJourneyTargets(g: Graph, milestones: JourneyMilestone[]): Map<string, V3> {
  const out = new Map<string, V3>();
  const laneY = journeyLaneY;

  // signed slot within a lane → x mirrored about NOW (done left, ahead right)
  const slotInLane = journeySlotIndex(milestones);

  out.set("hub", [HUB_X, 0, 0]);

  for (const m of milestones) {
    const slot = slotInLane.get(m.id) ?? 1; // <0 past (left), >0 future (right)
    const x = journeySlotX(slot);
    // Milestones stay on one stable initiative rail. The previous depth-based Y
    // fan made the whole roadmap bend toward the window edges, clipped the outer
    // rows, and made a route's vertical position depend on its age. Time is X;
    // initiative is Y. Keeping those dimensions orthogonal restores the readable
    // notebook/tree composition while the hub elbows still provide the branch fan.
    const y = laneY(m.areaId);
    let z = Z_PLANE + (seed01(m.id) * 2 - 1) * Z_PARALLAX;
    // completed work sits a touch FORWARD (toward camera) so the past branch reads
    // crisp and near instead of receding - show the past, not just the future.
    if (isDone(m.status)) z += 0.4;
    out.set(m.id, [x, y, z]);
  }

  // area medallion = the branch header - tucked partway out from the brain on the
  // area's busier side and lifted above the row, so its label names the branch
  // instead of stacking a competing dot on the NOW axis.
  const laneMaxSlot = new Map<string, number>();
  for (const m of milestones) {
    const s = slotInLane.get(m.id) ?? 1;
    laneMaxSlot.set(m.areaId, Math.max(laneMaxSlot.get(m.areaId) ?? -99, s));
  }
  for (const node of g.nodes) {
    if (node.tier !== 1) continue;
    const band = laneY(node.id);
    const side = (laneMaxSlot.get(node.id) ?? 0) > 0 ? 1 : -1; // future side if it has one
    out.set(node.id, [side * (CORE_CLEAR - STEP_X * 0.7), band, TIER_Z[1] * 0.5]); // on the row, just hub-ward of the first milestone (matches the original)
  }

  // Details use one predictable downward comb in every lane. Mirroring the comb
  // above the upper rails put leaves into the header/safe-area and made identical
  // milestone structures read differently depending on which initiative owned them.
  const childIndex = new Map<string, number>(); // running child # per parent
  for (const node of g.nodes) {
    if (node.tier !== 3 || !node.parentId) continue;
    const parent = g.byId.get(node.parentId);
    const pj = parent ? out.get(parent.id) : undefined;
    if (!parent || !pj) continue;
    const k = childIndex.get(parent.id) ?? 0;
    childIndex.set(parent.id, k + 1);
    const side = pj[0] < 0 ? -1 : 1; // cascade outward from NOW
    const x = pj[0] + side * (DETAIL_DX0 + k * DETAIL_DX_STEP);
    const y = pj[1] - (DETAIL_TOP + k * DETAIL_DY);
    const z = Z_DETAIL + (seed01(node.id) * 2 - 1) * Z_PARALLAX;
    out.set(node.id, [x, y, z]);
  }

  return out;
}

/** Stable lane index per area (kept for any consumer of the old API). */
export function laneIndexOf(g: Graph): Map<string, number> {
  const lanes = new Map<string, number>();
  const n = CLUSTER_ORDER.length;
  CLUSTER_ORDER.forEach((id, i) => lanes.set(id, i - (n - 1) / 2));
  for (const node of g.nodes) {
    if (node.tier === 1 && !lanes.has(node.id)) lanes.set(node.id, 0);
  }
  return lanes;
}

export type { NodeTier };
