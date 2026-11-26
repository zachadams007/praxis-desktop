/**
 * FlickerField - localized synapse flickers (design lock §semantic-firing).
 *
 * Pre-distributes a deterministic point cloud around EVERY node slot (capacity-
 * sized, so live sprouts flicker automatically when their slot activates). Each
 * frame the CPU uploads node position + activity + reveal into a tiny texture;
 * everything else (threshold gating, individual blink timing) runs in-shader.
 * Density rises where work runs - the glance-readable "side of the brain" cue.
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useRuntime, useThemeColors } from "./context";
import { useBloomTarget } from "./bloomSelection";
import { makeFlickerMaterial } from "./shaders";
import { CORE_AXES, SECTORS, sectorOf } from "./Hub";

// R9: synapse flicker lives ONLY inside the brain core - every slot outside
// the hub goes dormant (count 0). Density rises with overall work instead of
// scattering uninterpretable lights across the map.
const COUNT_BY_TIER: Record<number, number> = { 0: 240, 1: 0, 2: 0, 3: 0 };
// hub cloud radius is derived from the plexus size at build (see geo memo);
// these are the per-tier fallbacks
const RADIUS_BY_TIER: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
// brain ellipsoid semi-axes - the SINGLE source lives in Hub.tsx (consumed by
// the orb variant too), so the synapse cloud always matches the neuron mass.

export function FlickerField() {
  const rt = useRuntime();
  const colors = useThemeColors();

  const nodeTex = useMemo(() => {
    const data = new Float32Array(rt.cap * 2 * 4);
    const tex = new THREE.DataTexture(data, rt.cap, 2, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  }, [rt]);

  const geo = useMemo(() => {
    // deterministic cloud (mulberry-style hash - no Math.random, stable footage)
    let s = 48271;
    const rng = () => {
      s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x6d2b79f5) | 0;
      return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
    };
    let total = 0;
    for (let i = 0; i < rt.cap; i++) total += COUNT_BY_TIER[rt.tier[i]] ?? 0;

    const aNode = new Float32Array(total);
    const aOffset = new Float32Array(total * 3);
    const aPhase = new Float32Array(total);
    const aSpeed = new Float32Array(total);
    const aThreshold = new Float32Array(total);
    const aSize = new Float32Array(total);
    const aSector = new Float32Array(total);
    const aWarm = new Float32Array(total);
    // inside the plexus volume only: 0.8 of the CONTAINED core radius (R = size*0.66
    // in Hub.tsx). The core was pulled in (0.88 → 0.66) to open trunk-space, so the
    // synapse cloud must follow or the blinks scatter in the empty shell around it.
    const hubRadius = rt.nodes[0].size * 0.74 * 0.85;
    let v = 0;
    for (let i = 0; i < rt.cap; i++) {
      const count = COUNT_BY_TIER[rt.tier[i]] ?? 0;
      const radius = rt.tier[i] === 0 ? hubRadius : (RADIUS_BY_TIER[rt.tier[i]] ?? 0);
      for (let k = 0; k < count; k++) {
        aNode[v] = i;
        // gaussian-ish shell: deeper points cluster toward the node;
        // squashed to the brain ellipsoid so blinks stay inside the mass
        const r = radius * Math.cbrt(rng());
        const th = rng() * Math.PI * 2;
        const ph = Math.acos(2 * rng() - 1);
        const ox = r * Math.sin(ph) * Math.cos(th) * CORE_AXES.x;
        const oy = r * Math.cos(ph) * CORE_AXES.y;
        const oz = r * Math.sin(ph) * Math.sin(th) * CORE_AXES.z;
        aOffset[v * 3] = ox;
        aOffset[v * 3 + 1] = oy;
        aOffset[v * 3 + 2] = oz;
        // sector = the cluster lobe this spark sits in (aligns firing density to
        // the worked area); a fraction fire hot red/orange instead of blue-white
        aSector[v] = sectorOf(ox, oy);
        aWarm[v] = rng() < 0.24 ? 1 : 0;
        aPhase[v] = rng() * Math.PI * 2;
        aSpeed[v] = 1.6 + rng() * 3.4;
        aThreshold[v] = 0.06 + rng() * 0.9;
        aSize[v] = 0.7 + rng() * 1.1;
        v++;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(total * 3), 3));
    g.setAttribute("aNode", new THREE.BufferAttribute(aNode, 1));
    g.setAttribute("aOffset", new THREE.BufferAttribute(aOffset, 3));
    g.setAttribute("aPhase", new THREE.BufferAttribute(aPhase, 1));
    g.setAttribute("aSpeed", new THREE.BufferAttribute(aSpeed, 1));
    g.setAttribute("aThreshold", new THREE.BufferAttribute(aThreshold, 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(aSize, 1));
    g.setAttribute("aSector", new THREE.BufferAttribute(aSector, 1));
    g.setAttribute("aWarm", new THREE.BufferAttribute(aWarm, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5); // shader-positioned
    return g;
  }, [rt]);

  const mat = useMemo(
    () => makeFlickerMaterial(nodeTex, rt.cap, colors.baseCool, colors.accent, colors.accentHot),
    [nodeTex, rt, colors],
  );

  // tier-1 area node per sector (graph order == ring order == sector order) - the
  // source of the per-sector firing surge
  const areaNode = useMemo(() => {
    const map = new Int32Array(SECTORS).fill(-1);
    let k = 0;
    for (let i = 0; i < rt.n; i++) {
      if (rt.tier[i] === 1) {
        if (k < SECTORS) map[k] = i;
        k++;
      }
    }
    return map;
  }, [rt]);
  const R = rt.nodes[0].size * 0.74;

  useEffect(() => () => geo.dispose(), [geo]);
  useEffect(() => () => mat.dispose(), [mat]);
  useEffect(() => () => nodeTex.dispose(), [nodeTex]);

  const ref = useRef<THREE.Points>(null);
  useBloomTarget(ref); // synapse sparks bloom

  useFrame((state) => {
    rt.tick(state);
    mat.uniforms.uTime.value = state.clock.elapsedTime;

    // per-sector work surge → firing concentrates on the worked side of the brain
    const sw = mat.uniforms.uSectorWork.value as Float32Array;
    for (let k = 0; k < SECTORS; k++) {
      const idx = areaNode[k];
      sw[k] = idx >= 0
        ? Math.min(1, Math.max(0, rt.activity[idx] - rt.ambient[idx] * 1.2) * 1.8)
        : 0;
    }
    // DoF focus tracks the core (matches Hub) so sparks recede with the volume
    const camDist = state.camera.position.distanceTo(rt.focusTarget);
    mat.uniforms.uFocusDist.value = camDist - 0.4 * R;
    mat.uniforms.uDofRange.value = Math.min(30, Math.max(6, camDist * 0.42));

    const data = nodeTex.image.data as Float32Array;
    const rowB = rt.cap * 4;
    for (let i = 0; i < rt.cap; i++) {
      if (i >= rt.n) {
        data[i * 4 + 3] = 0; // dormant slot: no activity → no flicker
        data[rowB + i * 4] = 0;
        continue;
      }
      data[i * 4] = rt.pos[i * 3];
      data[i * 4 + 1] = rt.pos[i * 3 + 1];
      data[i * 4 + 2] = rt.pos[i * 3 + 2];
      // the hub blinks with OVERALL work (rt.busy) so the core never reads dead
      data[i * 4 + 3] = i === 0 ? Math.max(rt.activity[0], rt.busy) : rt.nodeArrival[i];
      data[rowB + i * 4] = rt.reveal[i];
      data[rowB + i * 4 + 1] = i === 0 ? rt.ambient[i] : 0;
    }
    nodeTex.needsUpdate = true;
  });

  return <points ref={ref} geometry={geo} material={mat} frustumCulled={false} />;
}
