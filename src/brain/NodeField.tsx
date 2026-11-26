/**
 * NodeField - every non-hub node as a solid instanced core plus a soft additive
 * halo. Reads BrainRuntime each frame: glow drives hue (cool base → warm accent)
 * and bloom (aGlow), reveal drives scale (LOD cull as you fly out). Raycast picking
 * focuses a node on click; hover highlights.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { useRuntime, useThemeColors } from "./context";
import { useBloomTarget } from "./bloomSelection";
import { makeGlowMaterial, patchNodeFresnel } from "./shaders";
import { usePraxisStore } from "@/store/usePraxisStore";
import { areaHuesOf } from "@/theme/tokens";

const HALO_SCALE = 9; // a wider, softer bloom halo → premium glow, not a hot pinpoint

function depthFactor(tier: number): number {
  return tier === 1 ? 0.18 : tier === 2 ? 0.55 : 0.92;
}

// tier-3 artifact IDENTITY by kind - so the leaf-twigs read as distinct doc /
// file / memory nodes at a glance (not anonymous dots), even before labels
// fade in on approach. Cohesive with the cool/electric palette.
const KIND_HUE: Record<string, string> = {
  doc: "#37d8ff", // cyan
  file: "#6aa6ff", // blue
  memory: "#b08bff", // violet
};

export function NodeField() {
  const rt = useRuntime();
  const colors = useThemeColors();

  // instanceId i ↔ runtime node index list[i]. Tiers 2–3 (tasks + details)
  // only - the tier-1 cluster medallions are owned by ClusterField. Includes
  // dormant sprout capacity (spares render at scale 0 until activated, so a
  // brain-dump can sprout live without rebuilding any GPU buffers).
  const list = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < rt.cap; i++) if (rt.tier[i] >= 2) out.push(i);
    return out;
  }, [rt]);
  const count = list.length;

  // subdivision 3 (was 2): the instanced node cores read as smooth jewels rather than
  // faceted lumps at close range. It's ONE shared instanced geometry, so the extra
  // tris cost nothing per-node - a free silhouette-quality bump.
  const geo = useMemo(() => new THREE.IcosahedronGeometry(1, 3), []);
  const mat = useMemo(
    () => patchNodeFresnel(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })),
    [],
  );
  const aGlow = useMemo(() => new Float32Array(count), [count]);

  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const scratch = useMemo(() => new THREE.Color(), []);
  const flash = useMemo(() => new THREE.Color(), []); // pulse-arrival flash colour

  // base hue per node - color MEANS initiative (2026-07-05 node-color pass):
  // tasks wear their AREA's hue (softened toward the cool base so the map stays
  // in-theme, not carnival); detail leaves keep their artifact-KIND identity
  // (doc/file/memory) pulled 25% toward the area hue so a cluster's twigs read
  // as one family. Nodes without an area fall back to the old depth ramp.
  const baseCols = useMemo(() => {
    const hues = areaHuesOf(colors.palette);
    return list.map((idx) => {
      const nd = rt.nodes[idx];
      const areaHex = nd?.areaId ? hues[nd.areaId] : undefined;
      if (rt.tier[idx] === 3 && nd) {
        const hex = KIND_HUE[nd.kind];
        if (hex) {
          const c = new THREE.Color(hex);
          if (areaHex) c.lerp(new THREE.Color(areaHex), 0.25);
          return c.lerp(colors.baseWarm, 0.1);
        }
      }
      if (areaHex) {
        return new THREE.Color(areaHex).lerp(colors.baseCool, 0.32);
      }
      return colors.baseCool.clone().lerp(colors.baseWarm, depthFactor(rt.tier[idx]));
    });
  }, [list, rt, colors]);

  // ---- halos (additive points; positions follow the morph every frame) ----
  const haloGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(count), 1));
    g.setAttribute("aGlow", new THREE.BufferAttribute(new Float32Array(count), 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    return g;
  }, [count]);
  const haloMat = useMemo(() => makeGlowMaterial(), []);
  const haloRef = useRef<THREE.Points>(null);

  // Dispose the GPU buffers on remount/teardown (theme switch, count change) - every
  // sibling field does this; NodeField was the one gap, leaking an IcosahedronGeometry,
  // a MeshBasicMaterial, the halo BufferGeometry, and the glow material each remount.
  useEffect(() => {
    return () => {
      geo.dispose();
      mat.dispose();
      haloGeo.dispose();
      haloMat.dispose();
    };
  }, [geo, mat, haloGeo, haloMat]);
  // firing node cores + their halos bloom (the only node glow; chips/labels do not)
  useBloomTarget(meshRef);
  useBloomTarget(haloRef);

  useLayoutEffect(() => {
    geo.setAttribute("aGlow", new THREE.InstancedBufferAttribute(aGlow, 1));
    // seed instanceColor so the buffer exists
    const m = meshRef.current;
    if (m) {
      for (let i = 0; i < count; i++) m.setColorAt(i, baseCols[i]);
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }, [geo, aGlow, count, baseCols]);

  useFrame((state) => {
    rt.tick(state);
    const m = meshRef.current;
    if (!m) return;

    const st = usePraxisStore.getState();
    const selIdx = st.selectedId ? rt.index.get(st.selectedId) ?? -1 : -1;
    const hovIdx = st.hoverId ? rt.index.get(st.hoverId) ?? -1 : -1;

    const hAP = haloGeo.getAttribute("position") as THREE.BufferAttribute;
    const hAS = haloGeo.getAttribute("aSize") as THREE.BufferAttribute;
    const hAG = haloGeo.getAttribute("aGlow") as THREE.BufferAttribute;
    const hAC = haloGeo.getAttribute("aColor") as THREE.BufferAttribute;

    for (let i = 0; i < count; i++) {
      const idx = list[i];
      const nd = rt.nodes[idx]; // undefined = dormant sprout slot
      const rev = nd ? rt.reveal[idx] : 0;
      const arrival = nd ? rt.nodeArrival[idx] : 0;
      // Node bloom follows routed pathway energy and starts only on arrival.
      const firing = THREE.MathUtils.clamp(arrival * 1.15, 0, 1);

      // The halo carries the glow; the core keeps its initiative colour.
      scratch.copy(baseCols[i]).lerp(colors.accent, firing * 0.5);

      const selected = idx === selIdx;
      const hovered = idx === hovIdx;
      if (selected) scratch.lerp(colors.hub, 0.28);

      const px = rt.pos[idx * 3];
      const py = rt.pos[idx * 3 + 1];
      const pz = rt.pos[idx * 3 + 2];

      // Status, selection and hover affect metadata/scale, never independent bloom.
      const dim = (0.32 + 0.68 * rev) * 0.86;
      // Multiply in place + pass scratch directly - setColorAt copies its argument, so
      // a per-node `.clone()` would be pure GC churn. scratch's final value also feeds
      // the halo colour below (so the halo blooms in the same hue, flash included).
      scratch.multiplyScalar(dim);
      if (arrival > 0.002) {
        // match the arriving pulse's own colour family (PulseField): kind 1 = warm
        // memory packet, kind 0 = cool signal - white-hot core, added ADDITIVELY so the
        // bloom pass haloes the landing. Arrival is NOT dimmed by the breath.
        if (rt.nodeArrivalKind[idx] === 1) flash.copy(colors.baseWarm).lerp(colors.hub, 0.6);
        else flash.copy(colors.baseCool).lerp(colors.accent, 0.9);
        flash.lerp(colors.hub, 0.3 * Math.min(1, arrival));
        scratch.add(flash.multiplyScalar(arrival * 1.7));
      }
      m.setColorAt(i, scratch);

      aGlow[i] = arrival * 1.25 * (0.3 + 0.7 * rev);

      const size = nd ? nd.size : 0;
      const inspectedScale = selected ? 1.08 : hovered ? 1.12 : 1;
      const s = size * rev * inspectedScale + 1e-4;
      dummy.position.set(px, py, pz);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);

      // Halo is invisible at rest and carries only the routed arrival bloom.
      hAP.setXYZ(i, px, py, pz);
      hAS.setX(
        i,
        size * HALO_SCALE * (0.7 + arrival * 1.3) * (0.2 + 0.8 * rev),
      );
      hAG.setX(
        i,
        arrival * 1.15 * rev,
      );
      hAC.setXYZ(i, scratch.r, scratch.g, scratch.b);
    }

    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    (geo.getAttribute("aGlow") as THREE.BufferAttribute).needsUpdate = true;
    hAP.needsUpdate = true;
    hAS.needsUpdate = true;
    hAG.needsUpdate = true;
    hAC.needsUpdate = true;
  });

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.instanceId == null) return;
    const idx = list[e.instanceId];
    if (rt.reveal[idx] < 0.35) return;
    e.stopPropagation();
    usePraxisStore.getState().focus(rt.nodes[idx].id);
  };
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (e.instanceId == null) return;
    const idx = list[e.instanceId];
    if (rt.reveal[idx] < 0.35) return;
    e.stopPropagation();
    usePraxisStore.getState().setHover(rt.nodes[idx].id);
    document.body.style.cursor = "pointer";
  };
  const onOut = () => {
    usePraxisStore.getState().setHover(null);
    document.body.style.cursor = "auto";
  };

  return (
    <group>
      <instancedMesh
        ref={meshRef}
        args={[geo, mat, count]}
        frustumCulled={false}
        onClick={onClick}
        onPointerMove={onMove}
        onPointerOut={onOut}
      />
      <points ref={haloRef} geometry={haloGeo} material={haloMat} frustumCulled={false} />
    </group>
  );
}
