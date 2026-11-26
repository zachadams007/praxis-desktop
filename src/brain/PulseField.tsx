/**
 * PulseField - the firing neurons AND the directional flow.
 *
 * Two additive-point layers, both bloom-selected:
 *
 *  1. Event pulses (the runtime's pooled particle system) - a burst travels a
 *     hub→node chain when something fires (think / task / memory / file / sprout).
 *     Now positioned ON the routed Bézier (runtime), so a pulse rides the tube.
 *
 *  2. Flow BEADS (this layer) - active pathways carry a directional train from
 *     parent to child. Idle and merely focused paths carry no beads. Beads sample
 *     the SAME Bézier the tube + pulses
 *     use (edgeRoute), so they sit exactly on the path; colour is the path's area
 *     hue brightening to the accent as it fires.
 *
 * The installed app is truth-driven: no event means no moving pathway light.
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { areaHuesOf } from "@/theme/tokens";
import { useRuntime, useThemeColors } from "./context";
import { makeGlowMaterial } from "./shaders";
import { useBloomTarget } from "./bloomSelection";
import { cubicBezierPoint, edgeControlPoints } from "./edgeRoute";

const BEADS_PER_EDGE = 3;
// bead point-size by edge tier (trunks fattest → details finest)
const BEAD_SIZE_BY_TIER: Record<number, number> = { 1: 16, 2: 9, 3: 6, 4: 7.5 };

export function PulseField() {
  const rt = useRuntime();
  const colors = useThemeColors();
  const max = rt.pBright.length;

  // ---- event pulses (pooled, runtime-driven) ----
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(max), 1));
    g.setAttribute("aGlow", new THREE.BufferAttribute(new Float32Array(max), 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    return g;
  }, [max]);
  const mat = useMemo(() => makeGlowMaterial(), []);
  const scratch = useMemo(() => new THREE.Color(), []);

  // ---- directional flow beads (analytic, gated on edgeActive) ----
  const beadCap = rt.eCap * BEADS_PER_EDGE;
  const beadGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(beadCap * 3), 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(beadCap), 1));
    g.setAttribute("aGlow", new THREE.BufferAttribute(new Float32Array(beadCap), 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(beadCap * 3), 3));
    return g;
  }, [beadCap]);
  const beadMat = useMemo(() => makeGlowMaterial(), []);
  const beadColor = useMemo(() => new THREE.Color(), []);
  // per-edge EASED activity - raw edgeActive spikes per event, which made the bead
  // trains surge/jitter ("overkill"); easing gives a calm swell that still tracks
  // real task activity (the owner's smoothness fix, 2026-07-05)
  const actEase = useMemo(() => new Float32Array(rt.eCap), [rt]);
  // per-edge phase ACCUMULATOR (0..1, integrated by speed·dt each frame). Driving the
  // bead position off an accumulator instead of `time * speed` means a changing speed
  // eases the flow smoothly rather than teleporting the beads at the modulo wrap - the
  // "glitchy" bead trains were caused by speed jumping under `time * speed`.
  const phase = useMemo(() => {
    const a = new Float32Array(rt.eCap);
    for (let e = 0; e < a.length; e++) a[e] = (e % 13) / 13; // stagger the trains at start
    return a;
  }, [rt]);
  const lastTime = useRef(-1);
  const c1 = useMemo(() => new Float32Array(3), []);
  const c2 = useMemo(() => new Float32Array(3), []);
  const point = useMemo(() => new Float32Array(3), []);

  // per-area hue (linear rgb), rebuilt on theme flip - matches EdgeField
  const hueByArea = useMemo(() => {
    const m = new Map<string, THREE.Color>();
    const hues = areaHuesOf(colors.palette);
    for (const [id, hex] of Object.entries(hues)) m.set(id, new THREE.Color(hex));
    return m;
  }, [colors]);

  useEffect(() => () => geo.dispose(), [geo]);
  useEffect(() => () => beadGeo.dispose(), [beadGeo]);
  useEffect(() => () => mat.dispose(), [mat]);
  useEffect(() => () => beadMat.dispose(), [beadMat]);

  // both layers bloom
  const pulseRef = useRef<THREE.Points>(null);
  const beadRef = useRef<THREE.Points>(null);
  useBloomTarget(pulseRef);
  useBloomTarget(beadRef);

  useFrame((state) => {
    rt.tick(state);
    const time = state.clock.elapsedTime;
    // frame dt (clamped) for the smooth per-edge phase integration below
    const dt = lastTime.current < 0 ? 1 / 60 : Math.min(0.05, time - lastTime.current);
    lastTime.current = time;

    // --- event pulses ---
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    const posArr = pos.array as Float32Array;
    const aSize = geo.getAttribute("aSize").array as Float32Array;
    const aGlow = geo.getAttribute("aGlow").array as Float32Array;
    const aColor = geo.getAttribute("aColor") as THREE.BufferAttribute;
    posArr.set(rt.pPos);
    for (let i = 0; i < max; i++) {
      const b = rt.pBright[i];
      aGlow[i] = b * 1.4;
      if (b > 0.002) {
        if (rt.pKind[i] === 1) {
          aSize[i] = 13 + b * 8;
          scratch.copy(colors.baseWarm).lerp(colors.hub, THREE.MathUtils.clamp(b, 0, 1) * 0.6);
        } else {
          aSize[i] = 9 + b * 9;
          scratch.copy(colors.baseCool).lerp(colors.accent, THREE.MathUtils.clamp(b * 1.2, 0, 1));
        }
        aColor.setXYZ(i, scratch.r, scratch.g, scratch.b);
      } else {
        aSize[i] = 0;
      }
    }
    pos.needsUpdate = true;
    geo.getAttribute("aSize").needsUpdate = true;
    geo.getAttribute("aGlow").needsUpdate = true;
    aColor.needsUpdate = true;

    // --- flow beads ---
    const bPos = beadGeo.getAttribute("position");
    const bPosArr = bPos.array as Float32Array;
    const bSize = beadGeo.getAttribute("aSize").array as Float32Array;
    const bGlow = beadGeo.getAttribute("aGlow").array as Float32Array;
    const bCol = beadGeo.getAttribute("aColor") as THREE.BufferAttribute;
    const jm = rt.morph;

    for (let e = 0; e < rt.eCap; e++) {
      const base = e * BEADS_PER_EDGE;
      if (e >= rt.edgeCount) {
        for (let k = 0; k < BEADS_PER_EDGE; k++) bSize[base + k] = 0;
        continue;
      }
      const a = rt.eA[e];
      const b = rt.eB[e];
      const tier = rt.eTier[e];
      const areaIdx = rt.areaIndex[b];
      // eased activity: quick-ish rise, slow decay - a working pathway holds a calm
      // steady flow instead of strobing with every individual event
      const raw = Math.min(rt.edgeActive[e], 1.1);
      actEase[e] += (raw - actEase[e]) * (raw > actEase[e] ? 0.06 : 0.02);
      const act = actEase[e];

      // Tier-4 story links only flow as the corridor forms.
      const modeMul = tier === 4 ? jm : tier === 1 ? 1 - jm * 0.5 : 1;
      const drive = Math.min(act * modeMul, 1.6);

      const revMin = Math.min(rt.reveal[a], rt.reveal[b]);
      if (drive < 0.02 || revMin < 0.02) {
        for (let k = 0; k < BEADS_PER_EDGE; k++) bSize[base + k] = 0;
        continue;
      }

      const ax = rt.pos[a * 3];
      const ay = rt.pos[a * 3 + 1];
      const az = rt.pos[a * 3 + 2];
      const bx = rt.pos[b * 3];
      const by = rt.pos[b * 3 + 1];
      const bz = rt.pos[b * 3 + 2];
      edgeControlPoints(ax, ay, az, bx, by, bz, tier, c1, c2, jm);

      // Advance a per-edge phase ACCUMULATOR by speed·dt so a rising/falling speed eases the
      // current instead of snapping the beads (the smoothness fix). Wrapped to 0..1.
      const speed = 0.11 + act * 0.12;
      let ph = phase[e] + speed * dt;
      ph -= Math.floor(ph);
      phase[e] = ph;

      const areaId = areaIdx >= 0 ? rt.nodes[areaIdx]?.areaId ?? null : null;
      const hue = (areaId && hueByArea.get(areaId)) || colors.edge;
      beadColor.copy(hue).lerp(colors.accent, Math.min(act, 1));
      const sizeBase = BEAD_SIZE_BY_TIER[tier] ?? 7;

      for (let k = 0; k < BEADS_PER_EDGE; k++) {
        const bi = base + k;
        const tt = (ph + k / BEADS_PER_EDGE) % 1;
        cubicBezierPoint(
          ax, ay, az,
          c1[0], c1[1], c1[2],
          c2[0], c2[1], c2[2],
          bx, by, bz, tt, point,
        );
        bPosArr[bi * 3] = point[0];
        bPosArr[bi * 3 + 1] = point[1];
        bPosArr[bi * 3 + 2] = point[2];
        const env = Math.sin(tt * Math.PI); // emerge at the parent, arrive at the child
        bSize[bi] = sizeBase * (0.45 + 0.7 * env) * Math.min(1, revMin * 1.6);
        bGlow[bi] = drive * revMin * (0.4 + 0.6 * env) * 1.35;
        bCol.setXYZ(bi, beadColor.r, beadColor.g, beadColor.b);
      }
    }
    bPos.needsUpdate = true;
    beadGeo.getAttribute("aSize").needsUpdate = true;
    beadGeo.getAttribute("aGlow").needsUpdate = true;
    bCol.needsUpdate = true;
  });

  return (
    <group>
      <points ref={pulseRef} geometry={geo} material={mat} frustumCulled={false} />
      <points ref={beadRef} geometry={beadGeo} material={beadMat} frustumCulled={false} />
    </group>
  );
}
