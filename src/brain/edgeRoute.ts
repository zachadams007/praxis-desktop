/**
 * edgeRoute - the connectome's path geometry, shared so beads + pulses sit ON the
 * rendered tube.
 *
 * Every pathway is a CUBIC Bézier A→C1→C2→B with RADIAL tangents at both ends:
 * each branch leaves the parent heading straight outward from the core, bends
 * through a smooth elbow, and arrives at the child heading straight outward again
 * (the spider-branch shape the owner drew, IMG_1231). The tube itself is rebuilt from
 * this curve on the GPU (shaders.ts TENDRIL_VERT) using control points the CPU
 * writes per edge (EdgeField.tsx). To keep travelling beads (PulseField.tsx) and
 * event pulses (runtime.ts) exactly on that tube, they evaluate the SAME curve via
 * the helpers below.
 *
 * ⚠ KEEP IN SYNC: `edgeControlPoints` mirrors the C1/C2 block in EdgeField.tsx and
 * `cubicBezierPoint` mirrors the spine in shaders.ts `TENDRIL_VERT`. If the elbow
 * tuning there changes (the 0.5 / 0.33 / camBow constants), update it here too, or
 * beads drift off the path. Pure scalars + caller-owned `out` arrays → zero
 * per-frame allocation, and the module is three.js-free so the runtime can use it.
 */

/**
 * The two cubic control points for the parent(A)→child(B) branch, written into
 * `outC1`/`outC2` ([x,y,z] each). `tier === 1` (or a parent at the core) keeps the
 * hub→area trunk a clean near-straight spoke; deeper branches launch/arrive along
 * the radial axis. Mirrors EdgeField.tsx.
 */
export function edgeControlPoints(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  tier: number,
  outC1: Float32Array | number[],
  outC2: Float32Array | number[],
  jm = 0,
): void {
  const rA = Math.hypot(ax, ay);
  const rB = Math.hypot(bx, by) || 1e-4;
  const len = Math.hypot(bx - ax, by - ay, bz - az) || 1e-4;
  const gap = Math.abs(rB - rA);
  const k = 0.5 * Math.max(gap, len * 0.25); // floor keeps near-radial edges bowed
  const camBow = Math.min(len * 0.05, 1.0); // gentle lean toward camera (+z) = volume
  let c1x: number, c1y: number, c2x: number, c2y: number;
  if (tier === 4) {
    // journey DEPENDENCY edge: smooth horizontal-tangent S-elbow (mirrors
    // EdgeField - KEEP IN SYNC). The owner LOCKED this shape for the hub→row
    // branches (2026-07-05) - do not re-angle the departure.
    const dx = bx - ax;
    const sx = dx >= 0 ? 1 : -1;
    const h = Math.max(Math.abs(dx) * 0.5, 2.2);
    c1x = ax + sx * h;
    c1y = ay;
    c2x = bx - sx * h;
    c2y = by;
  } else if (tier === 1 || rA < 0.5) {
    // hub→area trunk: A sits at/near the core so radial(A) is undefined → keep it
    // a clean, near-straight luminous spoke (controls on the A→B line)
    c1x = ax + (bx - ax) * 0.33;
    c1y = ay + (by - ay) * 0.33;
    c2x = bx - (bx - ax) * 0.33;
    c2y = by - (by - ay) * 0.33;
  } else {
    const raX = ax / rA;
    const raY = ay / rA;
    const rbX = bx / rB;
    const rbY = by / rB;
    c1x = ax + raX * k; // leave A straight outward
    c1y = ay + raY * k;
    c2x = bx - rbX * k; // arrive at B straight outward
    c2y = by - rbY * k;
  }
  // tier-3 artifact twigs read radially in BRAIN mode; in JOURNEY mode each leaf
  // DEPARTS its milestone already curving outward toward its own x, then hooks in
  // from above - fanned S-elbows that never hug the shared vertical (the owner's
  // artifact-overlap fix, 2026-07-05). Mirrors EdgeField - KEEP IN SYNC.
  if (tier === 3 && jm > 0) {
    // one S-elbow language (mirrors EdgeField - KEEP IN SYNC): vertical drop with a
    // slight outward tilt, curve back, arrive vertically from above.
    const hv = Math.max(Math.abs(ay - by) * 0.5, 0.7);
    const dir = by >= ay ? 1 : -1;
    const jx1 = ax + (bx - ax) * 0.3;
    const jy1 = ay + dir * hv;
    const jx2 = bx;
    const jy2 = by - dir * hv;
    c1x = c1x + (jx1 - c1x) * jm;
    c1y = c1y + (jy1 - c1y) * jm;
    c2x = c2x + (jx2 - c2x) * jm;
    c2y = c2y + (jy2 - c2y) * jm;
  }
  outC1[0] = c1x;
  outC1[1] = c1y;
  outC2[0] = c2x;
  outC2[1] = c2y;
  outC1[2] = az + (bz - az) * 0.33 + camBow;
  outC2[2] = bz - (bz - az) * 0.33 + camBow;
}

/**
 * Point at parameter `t` (0 = parent A, 1 = child B) on the cubic Bézier
 * A→C1→C2→B. Writes [x,y,z] into `out`. Mirrors shaders.ts `TENDRIL_VERT`.
 */
export function cubicBezierPoint(
  ax: number,
  ay: number,
  az: number,
  c1x: number,
  c1y: number,
  c1z: number,
  c2x: number,
  c2y: number,
  c2z: number,
  bx: number,
  by: number,
  bz: number,
  t: number,
  out: Float32Array | number[],
): void {
  const mt = 1 - t;
  const wa = mt * mt * mt;
  const w1 = 3 * mt * mt * t;
  const w2 = 3 * mt * t * t;
  const wb = t * t * t;
  out[0] = wa * ax + w1 * c1x + w2 * c2x + wb * bx;
  out[1] = wa * ay + w1 * c1y + w2 * c2y + wb * by;
  out[2] = wa * az + w1 * c1z + w2 * c2z + wb * bz;
}
