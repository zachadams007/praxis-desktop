/**
 * ClusterField - the tier-1 cluster MEDALLIONS, rebuilt to BLEND with the core (2026-06-15). Now
 * each cluster is a small NEURAL KNOT - a mini-connectome of accent-coloured neuron points + a
 * few filaments, the SAME additive language as the core plexus - framed by a thin state ring
 * with the glyph as a quiet identity badge. So a cluster reads as a node of the same organism,
 * not a sticker beside it.
 *
 * Identity per cluster: its accent HUE (shared with the core lobe + trunk + label),
 * an iconic GLYPH, and a STATE RING (firing bright / idle hairline / paused frozen).
 * Click flies to the cluster; hover highlights. The knot fades out in journey mode
 * (the roadmap is NOW + tasks only) via each knot material's uDim.
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { useRuntime, useThemeColors } from "./context";
import { usePraxisStore, observedMilestoneIds } from "@/store/usePraxisStore";
import {
  AREA_GLYPH,
  ORBITAL_SIGIL,
  constellationSigil,
  makeGlyphSprite,
  makePathSprite,
} from "@/glyphs/glyphs";
import { areaHuesOf } from "@/theme/tokens";
import { makeGlowMaterial } from "./shaders";

interface ClusterVis {
  idx: number; // runtime node index
  id: string;
  accent: THREE.Color;
  tex: THREE.CanvasTexture;
  knotPts: THREE.BufferGeometry;
  knotLines: THREE.BufferGeometry;
  ptsMat: THREE.ShaderMaterial; // own glow mat → per-cluster uDim fade
  linesMat: THREE.LineBasicMaterial; // own → per-cluster opacity fade
  arcMat: THREE.ShaderMaterial; // progress-arc fill (uProgress/uColor/uOpacity)
  planArcMat: THREE.ShaderMaterial; // faint under-arc: the AUTHORED plan, not a measurement
}

const RING_INNER = 1.95;
const RING_OUTER = 2.18;
const GLYPH_SCALE = 1.35;
const KNOT_PTS = 52;
const KNOT_R = 1.5; // knot fills toward the ring so the medallion reads as a node

// progress arc - a thin bright ring OUTSIDE the state ring; a shader fills it from
// 12 o'clock clockwise to uProgress (real task completion) so the medallion reads
// as a live gauge. Presence/colour (uColor·uOpacity) says an agent is working it.
const ARC_INNER = 2.28;
const ARC_OUTER = 2.46;

/** Per-cluster arc material - fills [12 o'clock → uProgress] clockwise, discards the
 *  rest, so the ring visibly "loads" as the initiative's tasks complete. Additive so
 *  it blooms like the rest of the connectome. */
function makeArcMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uProgress: { value: 0 },
      uColor: { value: new THREE.Color("#2be28f") },
      uOpacity: { value: 0 },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec2 vPos;
      void main() {
        vPos = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      uniform float uProgress;
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vPos;
      const float PI = 3.14159265;
      void main() {
        // angle at the fragment; t = 0 at top (12 o'clock), increasing CLOCKWISE
        float a = atan(vPos.y, vPos.x);            // -PI..PI
        float t = fract((PI * 0.5 - a) / (2.0 * PI));
        if (t > uProgress) discard;                // only the filled arc survives
        // soften the leading edge so the arc head isn't a hard chop
        float edge = smoothstep(0.0, 0.04, uProgress - t);
        gl_FragColor = vec4(uColor, uOpacity * (0.55 + 0.45 * edge));
      }
    `,
  });
}

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A small accent-coloured neuron knot + its near-neighbour filaments - the core's
 *  plexus language, miniaturised, so the cluster blends into the same organism. */
function buildKnot(accent: THREE.Color, white: THREE.Color, seed: number) {
  const rng = mulberry32(seed);
  const P = KNOT_PTS;
  const pos = new Float32Array(P * 3);
  const aSize = new Float32Array(P);
  const aGlow = new Float32Array(P);
  const aColor = new Float32Array(P * 3);
  for (let i = 0; i < P; i++) {
    const zz = 2 * rng() - 1;
    const th = rng() * Math.PI * 2;
    const sxy = Math.sqrt(1 - zz * zz);
    const rr = KNOT_R * Math.pow(rng(), 0.62); // denser toward the centre
    pos[i * 3] = sxy * Math.cos(th) * rr;
    pos[i * 3 + 1] = sxy * Math.sin(th) * rr;
    pos[i * 3 + 2] = zz * rr * 0.7; // flatter in z (sits near the map plane)
    // hot near-white at the heart of the knot → accent hue toward the rim
    const c = white.clone().lerp(accent, THREE.MathUtils.clamp(rr / KNOT_R + 0.15, 0, 1));
    aColor[i * 3] = c.r; aColor[i * 3 + 1] = c.g; aColor[i * 3 + 2] = c.b;
    aSize[i] = 2.4 + rng() * 3.2 + (1 - rr / KNOT_R) * 2.0;
    aGlow[i] = 0.28 + rng() * 0.32 + (1 - rr / KNOT_R) * 0.4;
  }
  const knotPts = new THREE.BufferGeometry();
  knotPts.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  knotPts.setAttribute("aSize", new THREE.BufferAttribute(aSize, 1));
  knotPts.setAttribute("aGlow", new THREE.BufferAttribute(aGlow, 1));
  knotPts.setAttribute("aColor", new THREE.BufferAttribute(aColor, 3));
  knotPts.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

  // filaments: each point links to its nearest 1–2 neighbours (the connectome read)
  const lp: number[] = [];
  const lc: number[] = [];
  const dim = accent.clone().multiplyScalar(0.5);
  for (let i = 0; i < P; i++) {
    const cand: { j: number; d2: number }[] = [];
    for (let j = 0; j < P; j++) {
      if (j === i) continue;
      const dx = pos[j * 3] - pos[i * 3];
      const dy = pos[j * 3 + 1] - pos[i * 3 + 1];
      const dz = pos[j * 3 + 2] - pos[i * 3 + 2];
      cand.push({ j, d2: dx * dx + dy * dy + dz * dz });
    }
    cand.sort((a, b) => a.d2 - b.d2);
    const k = 1 + (i % 2); // 1 or 2 links per point
    for (let n = 0; n < k && n < cand.length; n++) {
      const j = cand[n].j;
      if (j < i) continue; // dedupe
      lp.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]);
      lc.push(dim.r, dim.g, dim.b, dim.r, dim.g, dim.b);
    }
  }
  const knotLines = new THREE.BufferGeometry();
  knotLines.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(lp), 3));
  knotLines.setAttribute("color", new THREE.BufferAttribute(Float32Array.from(lc), 3));
  knotLines.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

  return { knotPts, knotLines };
}

export function ClusterField() {
  const rt = useRuntime();
  const colors = useThemeColors();
  const hues = useMemo(() => areaHuesOf(colors.palette), [colors.palette]);
  // the live A/B: classic glyph vs mono letter mark (dock CONTROLS → Sigil)
  const sigil = usePraxisStore((s) => s.clusterSigil);

  const clusters = useMemo<ClusterVis[]>(() => {
    const out: ClusterVis[] = [];
    let seed = 0x9135;
    for (let i = 0; i < rt.n; i++) {
      if (rt.tier[i] !== 1) continue;
      const node = rt.nodes[i];
      if (!node) continue;
      const hex = hues[node.id] ?? colors.palette.baseCool;
      const glyph = AREA_GLYPH[node.id] ?? "praxis";
      // 512px canvas (was 256) + higher anisotropy + trilinear mips → the sigil reads
      // as a crisp instrument mark at every zoom instead of softening to a smudge on
      // fly-in. Each of the three sigil options (glyph / orbital / constellation) gets
      // the same premium raster treatment.
      const tex = new THREE.CanvasTexture(
        sigil === "orbital"
          ? makePathSprite(ORBITAL_SIGIL, hex, { size: 512, glow: true, weight: 1.5 })
          : sigil === "constellation"
            ? makePathSprite(constellationSigil(node.id), hex, { size: 512, glow: true, weight: 1.6 })
            : makeGlyphSprite(glyph, hex, { size: 512, glow: true, weight: 1.7 }),
      );
      tex.anisotropy = 8;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      const accent = new THREE.Color(hex);
      const { knotPts, knotLines } = buildKnot(accent, colors.hub, (seed += 0x4f1b));
      const ptsMat = makeGlowMaterial();
      const linesMat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, toneMapped: false,
      });
      const arcMat = makeArcMaterial();
      const planArcMat = makeArcMaterial();
      out.push({ idx: i, id: node.id, accent, tex, knotPts, knotLines, ptsMat, linesMat, arcMat, planArcMat });
    }
    return out;
  }, [rt, hues, colors.palette.baseCool, colors.hub, sigil]);

  useEffect(
    () => () => {
      for (const c of clusters) {
        c.tex.dispose();
        c.knotPts.dispose();
        c.knotLines.dispose();
        c.ptsMat.dispose();
        c.linesMat.dispose();
        c.arcMat.dispose();
        c.planArcMat.dispose();
      }
    },
    [clusters],
  );

  const ringGeo = useMemo(() => new THREE.RingGeometry(RING_INNER, RING_OUTER, 64), []);
  useEffect(() => () => ringGeo.dispose(), [ringGeo]);
  // high-segment arc ring so the shader's discard edge is smooth
  const arcGeo = useMemo(() => new THREE.RingGeometry(ARC_INNER, ARC_OUTER, 128), []);
  useEffect(() => () => arcGeo.dispose(), [arcGeo]);
  // The plan under-arc sits just inside the measured one so the two never overlap
  // and the eye reads them as "plan" behind "actual".
  const planArcGeo = useMemo(
    () => new THREE.RingGeometry(ARC_INNER - 0.055, ARC_INNER - 0.012, 128),
    [],
  );
  useEffect(() => () => planArcGeo.dispose(), [planArcGeo]);

  // runtime task-node indices per cluster (tier-2 nodes rolling up to each area) -
  // built once so the per-frame progress read is cheap.
  const taskIdxByCluster = useMemo(
    () =>
      clusters.map((c) => {
        const out: number[] = [];
        for (let i = 0; i < rt.n; i++) if (rt.tier[i] === 2 && rt.areaIndex[i] === c.idx) out.push(i);
        return out;
      }),
    [clusters, rt],
  );

  const groupRefs = useRef<(THREE.Group | null)[]>([]);
  const knotRefs = useRef<(THREE.Group | null)[]>([]);
  const ringRefs = useRef<(THREE.Mesh | null)[]>([]);
  const ringMatRefs = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const arcRefs = useRef<(THREE.Mesh | null)[]>([]);
  const planArcRefs = useRef<(THREE.Mesh | null)[]>([]);
  const spriteMatRefs = useRef<(THREE.SpriteMaterial | null)[]>([]);
  const scratch = useMemo(() => new THREE.Color(), []);
  const arcCur = useRef<Float32Array | null>(null); // eased progress per cluster

  useFrame((state, delta) => {
    rt.tick(state);
    const st = usePraxisStore.getState();
    const paused = st.paused;
    const selIdx = st.selectedId ? rt.index.get(st.selectedId) ?? -1 : -1;
    const hovIdx = st.hoverId ? rt.index.get(st.hoverId) ?? -1 : -1;
    const t = state.clock.elapsedTime;
    const journeyFade = 1 - rt.morph;
    const dt = Math.min(0.05, delta); // clamped for stable, frame-rate-independent eases
    // Milestones a REAL journey:status event moved.
    const observedIds = observedMilestoneIds();

    // agents working per area (cheap: ~10 agents) → the arc's "an agent is on it"
    // presence. REAL agents only (spec §A.2), read from the runtime's own agent state
    // using the SAME `ag.real` rule as AgentField (a mock-filler attachment has
    // ag.real === false), so the "working" arc glow never lights from decorative
    // ambience - only a genuine agent orbiting a task in this cluster raises it.
    const areaWorking = new Map<string, number>();
    for (const ag of rt.agents) {
      if (ag.infra || !ag.real || ag.attachArea < 0) continue;
      const areaId = rt.nodes[ag.attachArea]?.id;
      if (areaId) areaWorking.set(areaId, (areaWorking.get(areaId) ?? 0) + 1);
    }
    if (!arcCur.current || arcCur.current.length < clusters.length) {
      arcCur.current = new Float32Array(clusters.length);
    }
    const aCur = arcCur.current;

    for (let k = 0; k < clusters.length; k++) {
      const c = clusters[k];
      const g = groupRefs.current[k];
      const rm = ringMatRefs.current[k];
      const sm = spriteMatRefs.current[k];
      const knot = knotRefs.current[k];
      if (!g) continue;

      g.position.set(rt.pos[c.idx * 3], rt.pos[c.idx * 3 + 1], rt.pos[c.idx * 3 + 2]);

      const ring = ringRefs.current[k];
      if (ring) ring.quaternion.copy(state.camera.quaternion);

      const firing = THREE.MathUtils.clamp(
        (rt.activity[c.idx] - rt.ambient[c.idx] * 1.1) * 1.8,
        0,
        1,
      );
      const selected = c.idx === selIdx;
      const hovered = c.idx === hovIdx;
      const focusBoost = selected ? 0.5 : hovered ? 0.3 : 0;
      const otherFocused = (selIdx >= 0 || hovIdx >= 0) && !selected && !hovered;

      // state ring: firing → bright accent pulse; idle → calm hairline; paused →
      // frozen + desaturated
      if (rm) {
        const pulse = paused ? 0 : Math.sin(t * 3.2 + k) * 0.5 + 0.5;
        const live = paused ? 0.12 : 0.26 + firing * 0.9 + firing * pulse * 0.25;
        rm.opacity = THREE.MathUtils.clamp((live + focusBoost) * journeyFade, 0, 1.5);
        scratch.copy(c.accent);
        if (paused) scratch.lerp(colors.baseCool, 0.6).multiplyScalar(0.5);
        else scratch.lerp(colors.hub, firing * 0.4 + focusBoost * 0.5);
        rm.color.copy(scratch);
      }

      // the neural knot: gently breathes + brightens on firing/focus; dims when
      // another cluster is focused; fades out as the journey roadmap forms.
      // Alternative sigils (orbital/constellation) quiet the knot hard so the
      // mark itself clearly reads - the "letter overlapped the knot" fix.
      const sigilDim = sigil === "glyph" ? 1 : 0.18;
      const vis = (otherFocused ? 0.5 : 1) * journeyFade * sigilDim;
      c.ptsMat.uniforms.uDim.value = vis * (1 + firing * 0.5 + focusBoost * 0.6);
      c.linesMat.opacity = vis * (0.7 + firing * 0.3);
      if (knot) {
        const breathe = 1 + Math.sin(t * 0.7 + k * 1.3) * 0.04 + firing * 0.14 + focusBoost * 0.1;
        knot.scale.setScalar(breathe);
        knot.rotation.z = t * 0.06 + k;
        knot.visible = vis > 0.02;
      }

      if (sm) sm.opacity = (otherFocused ? 0.55 : 1) * journeyFade;

      // ── progress arc: OBSERVED completion only ─────────────────────────────
      // This used to sum `nd.status === "done"` over the cluster's milestones,
      // where `status` is copied straight off AUTHORED_MILESTONES - a hand-typed
      // array. The ring was therefore authored_done / milestone_count: Catalyzed
      // pinned at 3/6, Praxis at 6/9, neither moving for anything that actually
      // happened. A ring that fills is read as a measurement, so it now counts
      // only milestones a REAL journey:status event moved (observedMilestoneIds)
      // plus genuine per-task progress. The authored plan is still drawn, as a
      // faint under-arc, so the plan is visible without being a claim.
      
      const arc = arcRefs.current[k];
      if (arc) arc.quaternion.copy(state.camera.quaternion); // billboard → true circle
      {
        const taskIdx = taskIdxByCluster[k];
        const observed = observedIds;
        let sum = 0;
        let planSum = 0;
        for (const ti of taskIdx) {
          const nd = rt.nodes[ti];
          const id = nd?.id ?? "";
          const done = nd?.status === "done";
          if (done) planSum += 1;
          // Only a status a real event moved counts toward the measured ring.
          const doneForReal = done && observed.has(id);
          sum += doneForReal ? 1 : st.tasks[id]?.progress ?? 0;
        }
        const target = taskIdx.length ? sum / taskIdx.length : 0;
        const planTarget = taskIdx.length ? planSum / taskIdx.length : 0;
        // ease the fill so it "loads" smoothly rather than snapping between polls -
        // dt-based exponential so the load-in rate is identical at 30 / 60 / 120fps
        // (the fixed 0.05 step ran ~2× faster on a 120Hz panel). Reflects REAL task
        // completion (sum of per-task progress), never a decorative sweep.
        aCur[k] += (target - aCur[k]) * (1 - Math.exp(-3.4 * dt));
        const working = (areaWorking.get(c.id) ?? 0) > 0 || firing > 0.05;
        c.arcMat.uniforms.uProgress.value = aCur[k];
        // Faint under-arc = the authored PLAN. Visible, clearly secondary, and
        // never mistaken for the measured fill above it.
        const planArc = planArcRefs.current[k];
        if (planArc) {
          planArc.quaternion.copy(state.camera.quaternion);
          c.planArcMat.uniforms.uProgress.value = planTarget;
          (c.planArcMat.uniforms.uColor.value as THREE.Color).copy(c.accent);
          c.planArcMat.uniforms.uOpacity.value =
            (planTarget > 0.004 ? 0.13 : 0) * journeyFade * (otherFocused ? 0.55 : 1);
        }
        // Working = brighter pull toward the hot core + pulse.
        scratch.copy(c.accent);
        if (working) scratch.lerp(colors.hub, 0.3);
        (c.arcMat.uniforms.uColor.value as THREE.Color).copy(scratch);
        const pulse = working && !paused ? 0.85 + 0.15 * (Math.sin(t * 3.4 + k) * 0.5 + 0.5) : 1;
        const present = working ? 0.95 : aCur[k] > 0.004 ? 0.34 : 0;
        c.arcMat.uniforms.uOpacity.value = present * pulse * journeyFade * (otherFocused ? 0.55 : 1);
      }

      const s = 1 + focusBoost * 0.18 + (paused ? 0 : firing * 0.05);
      g.scale.setScalar(s);
    }
  });

  const pick = (k: number, e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    usePraxisStore.getState().focus(clusters[k].id);
  };
  const hover = (k: number, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    usePraxisStore.getState().setHover(clusters[k].id);
    document.body.style.cursor = "pointer";
  };
  const out = () => {
    usePraxisStore.getState().setHover(null);
    document.body.style.cursor = "auto";
  };

  return (
    <group>
      {clusters.map((c, k) => (
        <group key={c.id} ref={(r) => (groupRefs.current[k] = r)}>
          {/* neural knot - same plexus language as the core, in the cluster accent */}
          <group ref={(r) => (knotRefs.current[k] = r)}>
            <points geometry={c.knotPts} material={c.ptsMat} frustumCulled={false} renderOrder={2} />
            <lineSegments geometry={c.knotLines} material={c.linesMat} frustumCulled={false} renderOrder={2} />
          </group>
          {/* state ring - billboarded with the glyph so it reads as a perfect
              circle, concentric with the sigil (never a tilted ellipse) */}
          <mesh geometry={ringGeo} ref={(r) => (ringRefs.current[k] = r)}>
            <meshBasicMaterial
              ref={(r) => (ringMatRefs.current[k] = r)}
              color={c.accent}
              transparent
              opacity={0.3}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
              toneMapped={false}
              side={THREE.DoubleSide}
            />
          </mesh>
          {/* progress arc - a shader-filled ring just outside the state ring; billboarded
              so it stays a true circle. Fills 12 o'clock→clockwise to real task progress;
              emerald + bright when an agent is working the cluster (Phase B must-have). */}
          <mesh geometry={planArcGeo} material={c.planArcMat} ref={(r) => (planArcRefs.current[k] = r)} renderOrder={2} />
          <mesh geometry={arcGeo} material={c.arcMat} ref={(r) => (arcRefs.current[k] = r)} renderOrder={3} />
          {/* sigil - billboarded identity badge, smaller so the knot reads first.
              No z offset: depthTest is already off, and any world-z push would
              re-introduce the projected off-centre drift under the camera tilt. */}
          <sprite
            scale={
              sigil === "glyph"
                ? [GLYPH_SCALE, GLYPH_SCALE, GLYPH_SCALE]
                : [GLYPH_SCALE * 1.9, GLYPH_SCALE * 1.9, GLYPH_SCALE * 1.9]
            }
            position={[0, 0, 0]}
            onClick={(e) => pick(k, e)}
            onPointerOver={(e) => hover(k, e)}
            onPointerOut={out}
          >
            <spriteMaterial
              ref={(r) => (spriteMatRefs.current[k] = r)}
              map={c.tex}
              transparent
              depthWrite={false}
              depthTest={false}
              toneMapped={false}
            />
          </sprite>
        </group>
      ))}
    </group>
  );
}
