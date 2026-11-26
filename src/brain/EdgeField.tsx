/**
 * EdgeField - the connectome as DATA-ROUTED PATHWAYS (round3-remodel-lock R7 +
 * the "edges must be meaningful pathways, not random strands" mandate).
 *
 * One merged tube mesh sized to edge CAPACITY, built once. Each frame the CPU
 * fills a 5-row DataTexture per edge - endpoints A/B (from rt.pos), two cubic
 * Bézier control points C1/C2 (written by edgeRoute.edgeControlPoints, which
 * also drives PulseField and runtime.ts so beads/pulses stay exactly on the
 * tube), a focus+context brightness, and the edge's area hue - and the vertex
 * shader rebuilds every tube as the cubic curve A→C1→C2→B. Each branch leaves
 * its parent heading radially outward from the core, bends through a smooth
 * elbow, and arrives at its child heading radially outward again (the spider
 * shape IMG_1231). So pathways:
 *   - follow the brain⇄journey morph (endpoints are rt.pos),
 *   - follow live sprout rewiring (eA/eB re-read every frame),
 *   - stay one draw call with zero geometry rebuilds,
 *   - have ZERO idle motion (curvature is routed, not seeded sway).
 *
 * Focus+context (the all-edges-at-once fix): at overview only the tier-1 trunks (the "light
 * paths to the areas") and anything actively firing read bright; everything else recedes to ~6%.
 * Focusing an area lights that area's whole chain and dims the rest.
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { areaHuesOf } from "@/theme/tokens";
import { usePraxisStore } from "@/store/usePraxisStore";
import { useRuntime, useThemeColors } from "./context";
import { useBloomTarget } from "./bloomSelection";
import { makeTendrilMaterial } from "./shaders";

const SEGS = 18; // rings along each tube (smoother curve than the old 14)
const RADIAL = 5; // vertices per ring
const TEX_ROWS = 6; // A · B · C1 · C2 · hue · pulse (cubic Bézier needs two controls)

// per-tier tube radius (trunk thick → detail thin)
const RADIUS_BY_TIER: Record<number, number> = { 1: 0.21, 2: 0.07, 3: 0.04, 4: 0.055 };
const CONTEXT_DIM = 0.055; // brightness of an unfocused, idle, non-trunk path

export function EdgeField() {
  const rt = useRuntime();
  const colors = useThemeColors();

  // resolved per-area hue (linear rgb), rebuilt on theme flip
  const hueByArea = useMemo(() => {
    const map = new Map<string, [number, number, number]>();
    const hues = areaHuesOf(colors.palette);
    for (const [id, hex] of Object.entries(hues)) {
      const c = new THREE.Color(hex);
      map.set(id, [c.r, c.g, c.b]);
    }
    return map;
  }, [colors]);
  const edgeFallback = useMemo<[number, number, number]>(
    () => [colors.edge.r, colors.edge.g, colors.edge.b],
    [colors],
  );

  // live texture: 5 rows × eCap. row0 A.xyz+act · row1 B.xyz+bright ·
  // row2 C1.xyz+focus · row3 C2.xyz · row4 hue.rgb+radius (cubic Bézier)
  const edgeTex = useMemo(() => {
    const data = new Float32Array(rt.eCap * TEX_ROWS * 4);
    const tex = new THREE.DataTexture(data, rt.eCap, TEX_ROWS, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  }, [rt]);

  // canonical tube geometry for every edge SLOT (built once, capacity-sized)
  const geo = useMemo(() => {
    const verts = rt.eCap * (SEGS + 1) * RADIAL;
    const aEdge = new Float32Array(verts);
    const aT = new Float32Array(verts);
    const aTheta = new Float32Array(verts);
    const index: number[] = [];
    let v = 0;
    for (let e = 0; e < rt.eCap; e++) {
      const base = v;
      for (let s = 0; s <= SEGS; s++) {
        for (let k = 0; k < RADIAL; k++) {
          aEdge[v] = e;
          aT[v] = s / SEGS;
          aTheta[v] = (k / RADIAL) * Math.PI * 2;
          v++;
        }
      }
      for (let s = 0; s < SEGS; s++) {
        for (let k = 0; k < RADIAL; k++) {
          const k2 = (k + 1) % RADIAL;
          const r0 = base + s * RADIAL;
          const r1 = base + (s + 1) * RADIAL;
          index.push(r0 + k, r1 + k, r0 + k2, r0 + k2, r1 + k, r1 + k2);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    // position is required by three's raycast/bounds even though the shader ignores it
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    g.setAttribute("aEdge", new THREE.BufferAttribute(aEdge, 1));
    g.setAttribute("aT", new THREE.BufferAttribute(aT, 1));
    g.setAttribute("aTheta", new THREE.BufferAttribute(aTheta, 1));
    g.setIndex(index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5); // shader-positioned
    return g;
  }, [rt]);

  const mat = useMemo(
    () => makeTendrilMaterial(edgeTex, rt.eCap, colors.accent, colors.baseCool),
    [edgeTex, rt, colors],
  );

  useEffect(() => () => geo.dispose(), [geo]);
  useEffect(() => () => mat.dispose(), [mat]);
  useEffect(() => () => edgeTex.dispose(), [edgeTex]);

  const ref = useRef<THREE.Mesh>(null);
  // the merged tube blooms; context edges are dim (tone-mapped) so they stay under
  // the bloom floor - only firing/focused/trunk segments cross it (R16).
  useBloomTarget(ref);

  useFrame((state) => {
    rt.tick(state);
    mat.uniforms.uTime.value = state.clock.elapsedTime;

    const data = edgeTex.image.data as Float32Array;
    const W = rt.eCap;
    const rowA = 0;
    const rowB = W * 4;
    const rowC1 = W * 8;
    const rowC2 = W * 12;
    const rowH = W * 16;
    const rowP = W * 20; // pulse: headT, glow, kind
    const jm = rt.morph;
    mat.uniforms.uJourney.value = jm;

    // resolve the focused AREA (live store read - no re-render). null/hub = overview.
    const focusId = usePraxisStore.getState().focusId;
    let focusAreaIdx = -1;
    if (focusId) {
      const fi = rt.index.get(focusId);
      if (fi !== undefined && rt.tier[fi] !== 0) {
        const ai = rt.areaIndex[fi];
        focusAreaIdx = ai >= 0 ? ai : fi;
      }
    }

    for (let e = 0; e < W; e++) {
      if (e >= rt.edgeCount) {
        data[rowA + e * 4 + 3] = 0;
        data[rowB + e * 4 + 3] = 0;
        continue;
      }
      const a = rt.eA[e];
      const b = rt.eB[e];
      const tier = rt.eTier[e];
      // journey dependency edges: a SAME-area edge is the initiative's sequential
      // SPINE (the clean left→right flow) → bright + thick; a CROSS-area dep is a
      // secondary link → dim + thin so it recedes instead of tangling the roadmap.
      // tier-4 journey branches: hub-rooted (a === hub index 0) is the line OUT of
      // the brain into an area; same-area is the milestone chain along that branch.
      // Both are the bright SPINE; a cross-area edge is a faint dependency arc.
      const isHubRoot = tier === 4 && a === 0;
      const sameAreaDep =
        tier === 4 && !isHubRoot && rt.areaIndex[a] >= 0 && rt.areaIndex[a] === rt.areaIndex[b];
      const isSpine = isHubRoot || sameAreaDep;

      const ax = rt.pos[a * 3];
      const ay = rt.pos[a * 3 + 1];
      const az = rt.pos[a * 3 + 2];
      const bx = rt.pos[b * 3];
      const by = rt.pos[b * 3 + 1];
      const bz = rt.pos[b * 3 + 2];

      // Each branch LEAVES the parent heading radially OUTWARD from the core and ARRIVES at the
      // child heading radially OUTWARD again, so the whole tree fans symmetrically instead of
      // every strand bowing one way into a swirl. C1 carries the outward tangent at A, C2 the
      // outward tangent at B; the tangent length is half the radial gap so the straight launch
      // is sized to how much further out the child sits (tier-3 leaf twigs stay short). Zero
      // idle motion - pure routed curve.
      const rA = Math.hypot(ax, ay);
      const rB = Math.hypot(bx, by) || 1e-4;
      const len = Math.hypot(bx - ax, by - ay, bz - az) || 1e-4;
      const gap = Math.abs(rB - rA);
      const k = 0.5 * Math.max(gap, len * 0.25); // floor keeps near-radial edges bowed
      const camBow = Math.min(len * 0.05, 1.0); // gentle lean toward camera (+z) = volume
      let c1x: number, c1y: number, c2x: number, c2y: number;
      if (tier === 4) {
        // journey branch - leave A heading along the time axis (right for future, left for past)
        // and arrive at B the same way. Do NOT re-angle these.
        const dx = bx - ax;
        const sx = dx >= 0 ? 1 : -1;
        const h = Math.max(Math.abs(dx) * 0.5, 2.2);
        c1x = ax + sx * h;
        c1y = ay;
        c2x = bx - sx * h;
        c2y = by;
      } else if (tier === 1 || rA < 0.5) {
        // hub→area trunk: a clean, near-straight luminous spoke (controls on the
        // A→B line - A sits at/near the core so a radial tangent is undefined)
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
      // tier-3 artifact twig: in JOURNEY mode it hangs in a comb beneath its
      // milestone. The old elbow left EVERY leaf straight down from the node
      // (shared vertical tangent) so the curves hugged and overlapped near the
      // top (the owner's zoom: socialAlerts/limiter-plan/market-signals). Now each
      // leaf DEPARTS already curving outward toward its own x (c1 rides toward
      // the leaf), then hooks in from above - same S-elbow character, fanned
      // apart from the first pixel. Mirrors edgeRoute - KEEP IN SYNC.
      if (tier === 3 && jm > 0) {
        // Not a diagonal swoop.
        const hv = Math.max(Math.abs(ay - by) * 0.5, 0.7);
        const dir = by >= ay ? 1 : -1;
        const jx1 = ax + (bx - ax) * 0.3; // slight outward tilt on the drop
        const jy1 = ay + dir * hv;        // full vertical tangent = real elbow
        const jx2 = bx;                   // arrive from directly above
        const jy2 = by - dir * hv;
        c1x = c1x + (jx1 - c1x) * jm;
        c1y = c1y + (jy1 - c1y) * jm;
        c2x = c2x + (jx2 - c2x) * jm;
        c2y = c2y + (jy2 - c2y) * jm;
      }
      const c1z = az + (bz - az) * 0.33 + camBow;
      const c2z = bz - (bz - az) * 0.33 + camBow;

      // per-edge area hue (color = which initiative)
      const areaIdx = rt.areaIndex[b];
      const areaId = areaIdx >= 0 ? rt.nodes[areaIdx]?.areaId ?? null : null;
      const hue = (areaId && hueByArea.get(areaId)) || edgeFallback;

      // focus + context brightness - the all-edges-at-once fix
      const onFocus = focusAreaIdx >= 0 && areaIdx === focusAreaIdx;
      let base: number;
      let focus = 0;
      if (focusAreaIdx >= 0) {
        // an area is focused: light its whole chain, dim everything else
        if (onFocus) {
          // tier-1 is THIS area's hub→trunk; when the area is focused that trunk just
          // points off to the (off-screen) hub as a meaningless spike sticking out of
          // the medallion - kill it. Light only the subtree (tiers 2-4).
          base = tier === 1 ? 0 : tier === 2 ? 0.34 : tier === 4 ? (isSpine ? 0.4 : 0.13) : 0.22;
          focus = tier === 1 ? 0 : 1;
        } else {
          base = CONTEXT_DIM;
        }
      } else {
        if (tier === 1) {
          base = 0.32; // calmer trunk spokes - the neural core is the hero, not the beams
          focus = 0.4;
        } else if (tier === 4) {
          // the brain→area lines + milestone chains read as the bright roadmap
          // SPINE; cross-area dependency arcs recede
          base = isSpine ? 0.36 : 0.065;
        } else if (tier === 2) {
          base = 0.2;
        } else {
          // tier-3 leaf twigs: lifted so every branch reads as ending in
          // leaf-twigs at the overview (IMG_1231), not in bare nothing
          base = 0.17;
        }
      }

      // mode crossfade: BRAIN shows the radial structural tree (tiers 1-2), JOURNEY
      // shows the hub-rooted branches + dependency arcs (tier-4). tier-3 artifact
      // twigs read in BOTH (radial in brain, comb in journey), so they never fade.
      const jmFade = tier === 4 ? jm : tier === 3 ? 1 : 1 - jm;
      const revMin = Math.min(rt.reveal[a], rt.reveal[b]);
      const act = Math.min(rt.edgeActive[e], 1.2);
      const radius =
        tier === 4 ? (isSpine ? 0.065 : 0.025) : RADIUS_BY_TIER[tier] ?? 0.06;
      const bright = (base + act * 0.6) * revMin * jmFade;

      data[rowA + e * 4] = ax;
      data[rowA + e * 4 + 1] = ay;
      data[rowA + e * 4 + 2] = az;
      data[rowA + e * 4 + 3] = act;

      data[rowB + e * 4] = bx;
      data[rowB + e * 4 + 1] = by;
      data[rowB + e * 4 + 2] = bz;
      data[rowB + e * 4 + 3] = bright;

      data[rowC1 + e * 4] = c1x;
      data[rowC1 + e * 4 + 1] = c1y;
      data[rowC1 + e * 4 + 2] = c1z;
      data[rowC1 + e * 4 + 3] = focus;

      data[rowC2 + e * 4] = c2x;
      data[rowC2 + e * 4 + 1] = c2y;
      data[rowC2 + e * 4 + 2] = c2z;
      data[rowC2 + e * 4 + 3] = 0;

      data[rowH + e * 4] = hue[0];
      data[rowH + e * 4 + 1] = hue[1];
      data[rowH + e * 4 + 2] = hue[2];
      data[rowH + e * 4 + 3] = radius;

      // pulse row - the head position + brightness + kind of the brightest pulse
      // currently riding this edge (runtime aggregates it each frame). This lights
      // the exact segment under a travelling light, independent of `bright` above.
      data[rowP + e * 4] = rt.edgePulseT[e];
      data[rowP + e * 4 + 1] = rt.edgePulseGlow[e];
      data[rowP + e * 4 + 2] = rt.edgePulseKind[e];
      data[rowP + e * 4 + 3] = 0;
    }
    edgeTex.needsUpdate = true;
  });

  return <mesh ref={ref} geometry={geo} material={mat} frustumCulled={false} />;
}
