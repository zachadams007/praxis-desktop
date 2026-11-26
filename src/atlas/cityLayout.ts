/**
 * Atlas city layout - the spatial task-board, computed deterministically.
 *
 * The iso city is a projection of the SAME model the brain renders (graph.ts +
 * journey.ts), so the two directions are two views of one truth. Districts =
 * initiatives, laid on a ground RING around the central core spire (continuity
 * with the brain's radial spokes, just dropped onto the XZ plane). Each district
 * holds its tasks as extruded buildings in a tidy mini-grid; HEIGHT encodes scope
 * and EMISSIVE encodes status (active/firing = the warm accent). Cross-initiative
 * dependencies (journey.ts JOURNEY_DEPS) aggregate to district→district CONDUITS
 * routed orthogonally along the ground (solid = blocks).
 *
 * Pure data + plain tuples - three.js-free, so it stays testable and the city is
 * byte-for-byte reproducible (seeded PRNG only; never Math.random).
 */

import { buildGraph, CLUSTER_ORDER } from "@/data/graph";
import { areaHuesOf } from "@/theme/tokens";
import {
  AUTHORED_MILESTONES,
  JOURNEY_DEPS,
  STATUS_RANK,
  type JourneyMilestone,
  type MilestoneStatus,
} from "@/data/journey";
import type { Palette } from "@/theme/tokens";

export type XZ = [number, number];
export type XYZ = [number, number, number];

export interface CityBuilding {
  taskId: string;
  areaId: string;
  label: string;
  status: MilestoneStatus;
  /** Center of the footprint on the ground (x, y=0, z). */
  pos: XYZ;
  /** World height of the extruded box (top face sits at y = height). */
  height: number;
  /** Footprint half-extents (square-ish). */
  footprint: number;
  /** 0..1 scope magnitude (drives height). */
  scope: number;
}

export interface CityDistrict {
  id: string;
  label: string;
  /** Pad center on the ground. */
  center: XZ;
  /** Even ring angle (radians). */
  angle: number;
  hue: string;
  taskIds: string[];
  /** Pad half-extents (x, z) sized to enclose its buildings. */
  pad: XZ;
  counts: Record<MilestoneStatus, number>;
  /** True when any task in the district is active (the spire beams to it). */
  firing: boolean;
}

export interface CityConduit {
  id: string;
  fromId: string;
  toId: string;
  /** Ground polyline (orthogonal, with one routed bend), y lifted slightly. */
  points: XYZ[];
  /** solid = prerequisite/blocks · dotted = related. */
  kind: "blocks" | "related";
}

export interface CityModel {
  districts: CityDistrict[];
  buildings: CityBuilding[];
  conduits: CityConduit[];
  byTask: Map<string, CityBuilding>;
  byDistrict: Map<string, CityDistrict>;
}

// ---- tunables -------------------------------------------------------------
const RING_R = 15.5; // core → district pad center
const CELL = 2.55; // building footprint pitch within a district
const COLS = 2; // mini-grid columns per district
const FOOT = 0.92; // building footprint half-extent
const H_BASE: Record<MilestoneStatus, number> = {
  done: 0.55,
  later: 1.15,
  next: 1.75,
  active: 2.65,
};
const CONDUIT_Y = 0.06;

function mulberry32(seed: number): () => number {
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

const scopeOf = (m: JourneyMilestone): number => {
  // scope = how much weight this work carries → drives building height. Status is
  // the dominant signal; a small stable per-task jitter gives the skyline variety.
  const base =
    m.status === "active" ? 0.86 : m.status === "next" ? 0.6 : m.status === "later" ? 0.42 : 0.24;
  const jitter = (mulberry32(hashStr(m.id))() - 0.5) * 0.22;
  return Math.min(1, Math.max(0.12, base + jitter));
};

let _cache: { key: string; model: CityModel } | null = null;

/**
 * Build the whole city. `palette` only feeds district accent hues, so we cache on
 * the resolved hue map (theme changes rebuild; nothing else does).
 */
export function buildCity(palette: Palette): CityModel {
  const hues = areaHuesOf(palette);
  const key = CLUSTER_ORDER.map((id) => `${id}:${hues[id]}`).join("|");
  if (_cache && _cache.key === key) return _cache.model;

  const g = buildGraph();
  const order = CLUSTER_ORDER;
  const n = order.length;

  const districts: CityDistrict[] = [];
  const buildings: CityBuilding[] = [];
  const byTask = new Map<string, CityBuilding>();
  const byDistrict = new Map<string, CityDistrict>();

  order.forEach((areaId, i) => {
    // even ring angle, starting at the back and walking clockwise so the front of
    // the iso frame opens onto a district rather than the gap between two
    const angle = -Math.PI / 2 + i * ((Math.PI * 2) / n);
    const cx = Math.cos(angle) * RING_R;
    const cz = Math.sin(angle) * RING_R;

    const milestones = AUTHORED_MILESTONES.filter((m) => m.areaId === areaId).sort(
      (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.order - b.order,
    );
    const rows = Math.max(1, Math.ceil(milestones.length / COLS));
    const gridW = (COLS - 1) * CELL;
    const gridD = (rows - 1) * CELL;

    const counts: Record<MilestoneStatus, number> = { done: 0, active: 0, next: 0, later: 0 };
    const taskIds: string[] = [];
    let firing = false;

    milestones.forEach((m, k) => {
      const col = k % COLS;
      const row = Math.floor(k / COLS);
      // local grid centered on the pad, then dropped at the district center
      const lx = col * CELL - gridW / 2;
      const lz = row * CELL - gridD / 2;
      const scope = scopeOf(m);
      const height = H_BASE[m.status] * (0.82 + scope * 0.5);
      const b: CityBuilding = {
        taskId: m.id,
        areaId,
        label: m.label,
        status: m.status,
        pos: [cx + lx, 0, cz + lz],
        height,
        footprint: FOOT,
        scope,
      };
      buildings.push(b);
      byTask.set(m.id, b);
      taskIds.push(m.id);
      counts[m.status]++;
      if (m.status === "active") firing = true;
    });

    const district: CityDistrict = {
      id: areaId,
      label: g.byId.get(areaId)?.label ?? areaId,
      center: [cx, cz],
      angle,
      hue: hues[areaId] ?? palette.baseCool,
      taskIds,
      pad: [gridW / 2 + CELL * 0.8, gridD / 2 + CELL * 0.8],
      counts,
      firing,
    };
    districts.push(district);
    byDistrict.set(areaId, district);
  });

  // ---- conduits: aggregate cross-area deps to district→district links --------
  const seen = new Set<string>();
  const conduits: CityConduit[] = [];
  for (const [from, to] of JOURNEY_DEPS) {
    const fa = AUTHORED_MILESTONES.find((m) => m.id === from)?.areaId;
    const ta = AUTHORED_MILESTONES.find((m) => m.id === to)?.areaId;
    if (!fa || !ta || fa === ta) continue; // within-district deps are implied by the grid
    const key2 = `${fa}>${ta}`;
    if (seen.has(key2)) continue;
    seen.add(key2);
    const A = byDistrict.get(fa);
    const B = byDistrict.get(ta);
    if (!A || !B) continue;
    conduits.push({
      id: `c.${fa}.${ta}`,
      fromId: fa,
      toId: ta,
      points: routeConduit(A.center, B.center),
      kind: "blocks",
    });
  }

  const model: CityModel = { districts, buildings, conduits, byTask, byDistrict };
  _cache = { key, model };
  return model;
}

/**
 * Orthogonal ground route between two pad centers: step out from A toward the
 * core ring, take ONE bend, and arrive at B - an L/Z polyline that hugs the
 * ground and reads as a routed conduit rather than a straight slash. Lifted a
 * hair off y=0 so it never z-fights the ground plane.
 */
function routeConduit(a: XZ, b: XZ): XYZ[] {
  const [ax, az] = a;
  const [bx, bz] = b;
  // mid bend biased toward the core so conduits sweep through the central plaza
  const mx = (ax + bx) * 0.5 * 0.55;
  const mz = (az + bz) * 0.5 * 0.55;
  return [
    [ax, CONDUIT_Y, az],
    [mx, CONDUIT_Y, az],
    [mx, CONDUIT_Y, mz],
    [bx, CONDUIT_Y, mz],
    [bx, CONDUIT_Y, bz],
  ];
}

/** Status → display color, resolved against a district hue + the palette accent. */
export function statusColor(status: MilestoneStatus, hue: string, palette: Palette): string {
  if (status === "active") return palette.accent; // firing = warm accent
  if (status === "done") return palette.edge; // settled = dim structural
  return hue; // next / later = the district's own hue
}
