/**
 * JourneyHandoffField - roadmap-level handoffs in the time-corridor (journey) view.
 *
 * In journey mode the story is a roadmap of milestones flowing left→right over time
 * across initiative lanes. When a milestone COMPLETES and feeds the next one down the
 * corridor, a warm "work product" packet flows along a bowed arc between the two nodes
 * (journey:handoff event → runtime milestone-handoff pool). It's the journey-native
 * companion to AgentField's cool-white agent→agent handoff: that shows people passing
 * a word; THIS shows the WORK itself advancing along the plan.
 *
 * The runtime gates packet brightness on the morph (mBright → 0 outside journey), so
 * this is invisible in the brain view and fades cleanly across the morph - no extra
 * mode checks here. Additive glow + transforms only → 60fps on WebView2.
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, type RootState } from "@react-three/fiber";
import * as THREE from "three";
import { useRuntime, useThemeColors } from "./context";
import { makeGlowMaterial } from "./shaders";
import { useBloomTarget } from "./bloomSelection";

const BEADS = 7; // beads per packet (head + tail) - a touch longer than agent packets
const HEAD = 12; // head point size (tapers down the tail)

export function JourneyHandoffField() {
  const rt = useRuntime();
  const colors = useThemeColors();
  const n = rt.mBright.length;

  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const c = n * BEADS;
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(c * 3), 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(c), 1));
    g.setAttribute("aGlow", new THREE.BufferAttribute(new Float32Array(c), 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(c * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    return g;
  }, [n]);
  const mat = useMemo(() => makeGlowMaterial(), []);
  useEffect(() => () => geo.dispose(), [geo]);
  useEffect(() => () => mat.dispose(), [mat]);

  const ref = useRef<THREE.Points>(null);
  const col = useMemo(() => new THREE.Color(), []);
  useBloomTarget(ref); // the roadmap packets bloom

  useFrame((state: RootState) => {
    rt.tick(state); // frame-guarded: integrate once, all fields read fresh arrays

    const pos = geo.getAttribute("position").array as Float32Array;
    const size = geo.getAttribute("aSize").array as Float32Array;
    const glow = geo.getAttribute("aGlow").array as Float32Array;
    const cAttr = geo.getAttribute("aColor") as THREE.BufferAttribute;
    // "work flowing forward" hue - a saturated ELECTRIC-BLUE pulse (the core's family), NOT the
    // warm accent. We ride baseCool toward hot white but stay bluer than the near-white
    // agent→agent packets, so the two reads stay distinct without any warm hue.
    col.copy(colors.baseCool).lerp(colors.hub, 0.3);

    for (let h = 0; h < n; h++) {
      const base = h * BEADS;
      const bright = rt.mBright[h];
      const a = rt.mFrom[h];
      const b = rt.mTo[h];
      if (bright <= 0.001 || a < 0 || b < 0) {
        for (let k = 0; k < BEADS; k++) size[base + k] = 0;
        continue;
      }
      // rebuild the SAME bowed quadratic the runtime integrates (these constants
      // MUST match runtime.update's milestone-handoff arc, or the beads drift off it)
      const ax = rt.pos[a * 3], ay = rt.pos[a * 3 + 1], az = rt.pos[a * 3 + 2];
      const bx = rt.pos[b * 3], by = rt.pos[b * 3 + 1], bz = rt.pos[b * 3 + 2];
      const dx = bx - ax, dy = by - ay;
      const planar = Math.hypot(dx, dy) || 1;
      const len = Math.hypot(dx, dy, bz - az) || 1;
      const bow = Math.min(Math.max(len * 0.26, 1.4), 5.0);
      const mx = (ax + bx) * 0.5 + (-dy / planar) * bow;
      const my = (ay + by) * 0.5 + (dx / planar) * bow;
      const mz = (az + bz) * 0.5 + Math.min(len * 0.16, 3.0) + 1.4;
      const p = rt.mProg[h];
      for (let k = 0; k < BEADS; k++) {
        const bi = base + k;
        const tt = Math.max(0, p - k * 0.045); // head leads, beads trail behind
        const mt = 1 - tt;
        const w0 = mt * mt, w1 = 2 * mt * tt, w2 = tt * tt;
        pos[bi * 3] = w0 * ax + w1 * mx + w2 * bx;
        pos[bi * 3 + 1] = w0 * ay + w1 * my + w2 * by;
        pos[bi * 3 + 2] = w0 * az + w1 * mz + w2 * bz;
        const fall = 1 - k / BEADS;
        size[bi] = HEAD * (0.4 + 0.6 * fall);
        glow[bi] = bright * fall * 1.6;
        cAttr.setXYZ(bi, col.r, col.g, col.b);
      }
    }
    geo.getAttribute("position").needsUpdate = true;
    geo.getAttribute("aSize").needsUpdate = true;
    geo.getAttribute("aGlow").needsUpdate = true;
    cAttr.needsUpdate = true;
  });

  return <points ref={ref} geometry={geo} material={mat} frustumCulled={false} />;
}
