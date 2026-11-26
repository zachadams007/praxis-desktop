/**
 * Hub - the Praxis CORE, rebuilt (2026-06-16, rebuild #5) as a soft, glowing
 * NEURAL NET: luminous SOMAS (cell bodies) sprouting a dominant branching
 * DENDRITE web, with FIRING synapses sparking through it (FlickerField). The
 * whole thing is sold as genuinely 3D - in a STILL, head-on, no-orbit frame (R2)
 * - by IN-SHADER DEPTH-OF-FIELD: each soma/dendrite computes its circle-of-
 * confusion from view-space depth vs a focus plane and grows + softens + dims
 * out of focus, so a sharp bright soma sits up front while dim soft somas recede
 * into blur. (See the long note in shaders.ts.)
 *
 * This REPLACES the rejected lit instanced sphere-neurons ("candy balls"): real
 * 3D here is NOT opaque occluding geometry + a key light - it is DoF + depth-
 * graded size/brightness + organic overlap + glow. A dark depth-writing occluder
 * still hides the deep-back so the front hemisphere genuinely occludes the back;
 * the plasma heart is the one HDR bloom anchor. Geometry builds ONCE; only glow,
 * the work-gated dendrite beads, and the slow object tumble animate.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useRuntime, useThemeColors } from "./context";
import { useBloomTarget } from "./bloomSelection";
import { CLUSTER_ORDER } from "@/data/graph";
import { areaHuesOf } from "@/theme/tokens";
import { makeArborMaterial, makeGlowMaterial, makeNucleusMaterial, makeSomaMaterial } from "./shaders";
import { usePraxisStore } from "@/store/usePraxisStore";

// sectors track the cluster ring so per-cluster firing + hue stay aligned with
// the radial map. Capped at 8 (the actTex + uSectorCol width).
export const SECTORS = Math.min(8, CLUSTER_ORDER.length);
const SECTOR_STEP = (Math.PI * 2) / SECTORS;
export function sectorOf(x: number, y: number): number {
  const th = Math.atan2(y, x);
  const i = Math.round((Math.PI / 2 - th) / SECTOR_STEP);
  return ((i % SECTORS) + SECTORS) % SECTORS;
}

// ONE source of the core ellipsoid semi-axes - consumed by FlickerField so its
// synapse-spark cloud fills the same envelope as the soma mass. Slightly wider
// than tall + shallower in z so it never reads as a perfect 1:1:1 ball.
export const CORE_AXES = { x: 1.0, y: 0.92, z: 0.86 } as const;

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// SOMAS - the glowing cell bodies. A handful of large "hero" somas near the
// front + a field of progressively smaller, dimmer ones receding through a real
// z-volume. The huge size/brightness/depth variance is half the 3D read (the
// in-shader DoF is the other half). A dense faint micro-haze fills the volume so
// the net reads thick, not sparse - but melts to soft blur out of focus.
// ---------------------------------------------------------------------------
const NHERO = 9; // big sharp foreground cell bodies
const NMAIN = 38; // somas that grow a dendrite arbor (incl. the heroes)
const NHAZE = 240; // tiny background cell bodies, no arbor

interface SomaSpec {
  x: number; y: number; z: number;
  size: number;
  sector: number;
  hero: number;
}

interface SomaGeo {
  points: THREE.BufferGeometry; // all somas (main + haze) as one Points
  mains: SomaSpec[]; // the arbor-bearing somas
}

function buildSomas(): SomaGeo {
  const rng = mulberry32(0x50a12026);
  const N = NMAIN + NHAZE;
  const pos = new Float32Array(N * 3);
  const aSize = new Float32Array(N);
  const aBright = new Float32Array(N);
  const aSeed = new Float32Array(N);
  const aSector = new Float32Array(N);
  const aHero = new Float32Array(N);
  const mains: SomaSpec[] = [];

  const place = (i: number, x: number, y: number, z: number, size: number, bright: number, hero: number) => {
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    aSize[i] = size; aBright[i] = bright; aSeed[i] = rng();
    aSector[i] = sectorOf(x, y); aHero[i] = hero;
  };

  for (let i = 0; i < NMAIN; i++) {
    const isHero = i < NHERO;
    const isLead = i === 0; // THE dominant foreground neuron (asymmetry + DoF anchor)
    // direction on the unit sphere
    const zz = 2 * rng() - 1;
    const th = rng() * Math.PI * 2;
    const sxy = Math.sqrt(1 - zz * zz);
    let dx = sxy * Math.cos(th), dy = sxy * Math.sin(th), dz = zz;
    // heroes bias toward the camera (+z, front) and a mid radius so they land
    // near the focus plane → razor sharp; the rest spread through the volume
    if (isHero) dz = 0.5 + Math.abs(dz) * 0.4;
    if (isLead) { dz = 0.85; dx = 0.62; dy = -0.26; } // front + off-centre, lands on focus
    let r = isHero ? 0.3 + rng() * 0.52 : 0.18 + Math.pow(rng(), 0.55) * 0.74;
    if (isLead) r = 0.52;
    const x = dx * r * CORE_AXES.x;
    const y = dy * r * CORE_AXES.y;
    const z = dz * r * CORE_AXES.z;
    const size = isLead ? 1.25 : isHero ? 0.7 + rng() * 0.45 : 0.18 + rng() * 0.2;
    const bright = isLead ? 1.8 : isHero ? 1.25 + rng() * 0.5 : 0.42 + rng() * 0.3;
    place(i, x, y, z, size, bright, isHero ? 1 : 0.18 + rng() * 0.35);
    mains.push({ x, y, z, size, sector: sectorOf(x, y), hero: isHero ? 1 : 0.3 });
  }

  for (let i = NMAIN; i < N; i++) {
    const zz = 2 * rng() - 1;
    const th = rng() * Math.PI * 2;
    const sxy = Math.sqrt(1 - zz * zz);
    const r = 0.12 + Math.pow(rng(), 0.5) * 0.95; // fills + slightly past the mass
    const x = sxy * Math.cos(th) * r * CORE_AXES.x;
    const y = sxy * Math.sin(th) * r * CORE_AXES.y;
    const z = zz * r * CORE_AXES.z;
    place(i, x, y, z, 0.035 + rng() * 0.07, 0.10 + rng() * 0.16, 0);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aSize", new THREE.BufferAttribute(aSize, 1));
  g.setAttribute("aBright", new THREE.BufferAttribute(aBright, 1));
  g.setAttribute("aSeed", new THREE.BufferAttribute(aSeed, 1));
  g.setAttribute("aSector", new THREE.BufferAttribute(aSector, 1));
  g.setAttribute("aHero", new THREE.BufferAttribute(aHero, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return { points: g, mains };
}

// ---------------------------------------------------------------------------
// DENDRITES - the dominant structure. Each main soma sprouts 4–7 primary
// dendrites that taper and BRANCH 2–3 levels into fine tips, curving organically
// (never straight spokes). Built once into ONE merged ribbon BufferGeometry; the
// vertex shader expands each segment into a camera-facing tapered glowing ribbon.
// ---------------------------------------------------------------------------
type V3 = [number, number, number];
const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

interface ArborBufs {
  pos: number[]; other: number[]; side: number[]; width: number[];
  along: number[]; seed: number[]; sector: number[]; col: number[];
  idx: number[]; vcount: { n: number };
}

function pushSegment(
  b: ArborBufs, p0: V3, p1: V3, w0: number, w1: number, a0: number, a1: number,
  seed: number, sector: number, c: V3,
) {
  const base = b.vcount.n;
  // 4 verts: (p0,-1) (p0,+1) (p1,-1) (p1,+1)
  const ends: [V3, V3, number, number][] = [
    [p0, p1, w0, a0], [p0, p1, w0, a0], [p1, p0, w1, a1], [p1, p0, w1, a1],
  ];
  const sides = [-1, 1, -1, 1];
  for (let k = 0; k < 4; k++) {
    const [pp, oo, ww, aa] = ends[k];
    b.pos.push(pp[0], pp[1], pp[2]);
    b.other.push(oo[0], oo[1], oo[2]);
    b.side.push(sides[k]);
    b.width.push(ww);
    b.along.push(aa);
    b.seed.push(seed);
    b.sector.push(sector);
    b.col.push(c[0], c[1], c[2]);
  }
  b.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  b.vcount.n += 4;
}

function buildArbors(mains: SomaSpec[], sectorCols: Float32Array): THREE.BufferGeometry {
  const rng = mulberry32(0xde2d2026);
  const b: ArborBufs = {
    pos: [], other: [], side: [], width: [], along: [], seed: [], sector: [], col: [], idx: [],
    vcount: { n: 0 },
  };

  const randUnit = (): V3 => {
    const zz = 2 * rng() - 1;
    const th = rng() * Math.PI * 2;
    const s = Math.sqrt(1 - zz * zz);
    return [s * Math.cos(th), s * Math.sin(th), zz];
  };

  // grow ONE curved, tapering branch; recursively spawn children
  const grow = (
    root: V3, dir0: V3, len: number, w0: number, w1: number,
    a0: number, a1: number, depth: number, seed: number, sector: number, col: V3,
  ) => {
    const SEGS = depth === 0 ? 5 : depth === 1 ? 4 : 3;
    // a baked sway axis → gentle organic curve along the branch
    let perp = norm(cross(dir0, randUnit()));
    if (!isFinite(perp[0])) perp = [0, 1, 0];
    const curve = (0.5 + rng() * 0.7) * (depth === 0 ? 1 : 0.7);
    let cur = root;
    let d = dir0;
    for (let s = 0; s < SEGS; s++) {
      const t0 = s / SEGS;
      const t1 = (s + 1) / SEGS;
      // bend the direction toward the perp as we go out (organic arc)
      d = norm(add(d, perp, (curve / SEGS) * (0.5 + t0)));
      // a touch of wander so no two branches are identical
      d = norm(add(d, randUnit(), 0.06));
      const next = add(cur, d, len / SEGS);
      const wA = w0 + (w1 - w0) * t0;
      const wB = w0 + (w1 - w0) * t1;
      const aA = a0 + (a1 - a0) * t0;
      const aB = a0 + (a1 - a0) * t1;
      pushSegment(b, cur, next, wA, wB, aA, aB, seed, sector, col);
      cur = next;
      // spawn a child partway out and continue (2–3 level tree)
      if (depth < 2 && s === Math.floor(SEGS * 0.55)) {
        const childCount = depth === 0 ? (rng() < 0.4 ? 2 : 1) : 1;
        for (let c = 0; c < childCount; c++) {
          const cd = norm(add(d, randUnit(), 0.85));
          grow(
            cur, cd, len * (0.55 + rng() * 0.18), wB * 0.7, wB * 0.32,
            aB, Math.min(1, aB + (depth === 0 ? 0.3 : 0.22)), depth + 1,
            rng(), sector, col,
          );
        }
      }
    }
    // a fine tip fork at the very end
    if (depth < 2) {
      const cd = norm(add(d, randUnit(), 1.1));
      grow(
        cur, cd, len * 0.42, w1, w1 * 0.4,
        a1, Math.min(1, a1 + 0.22), depth + 1, rng(), sector, col,
      );
    }
  };

  for (const m of mains) {
    const sCol: V3 = [
      sectorCols[m.sector * 3], sectorCols[m.sector * 3 + 1], sectorCols[m.sector * 3 + 2],
    ];
    const root: V3 = [m.x, m.y, m.z];
    const outward = norm(root.every((v) => v === 0) ? randUnit() : root);
    const primaries = 3 + Math.floor(rng() * 3); // 3–5 distinct thick dendrites
    const w0 = 0.019 + m.size * 0.044; // thicker trunk → reads as a primary dendrite
    for (let p = 0; p < primaries; p++) {
      // fan the primaries around the outward axis with a wide organic spread
      const dir = norm(add(outward, randUnit(), 0.8 + rng() * 0.6));
      const len = 0.42 + rng() * 0.4 + m.hero * 0.16;
      grow(root, dir, len, w0, w0 * 0.26, 0, 0.5, 0, rng(), m.sector, sCol);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(Float32Array.from(b.pos), 3));
  g.setAttribute("aOther", new THREE.BufferAttribute(Float32Array.from(b.other), 3));
  g.setAttribute("aSide", new THREE.BufferAttribute(Float32Array.from(b.side), 1));
  g.setAttribute("aWidth", new THREE.BufferAttribute(Float32Array.from(b.width), 1));
  g.setAttribute("aAlong", new THREE.BufferAttribute(Float32Array.from(b.along), 1));
  g.setAttribute("aSeed", new THREE.BufferAttribute(Float32Array.from(b.seed), 1));
  g.setAttribute("aSector", new THREE.BufferAttribute(Float32Array.from(b.sector), 1));
  g.setAttribute("aCol", new THREE.BufferAttribute(Float32Array.from(b.col), 3));
  g.setIndex(b.idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return g;
}

export function Hub() {
  const rt = useRuntime();
  const colors = useThemeColors();

  const reduce = useMemo(
    () =>
      typeof window !== "undefined" &&
      !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // world radius: SIZE.hub (graph.ts) ≈ 11 → R ≈ 8 - a contained core that opens
  // clean trunk-space to the branches while filling the R5 30–36% band
  const R = rt.nodes[0].size * 0.74;

  // per-sector cluster hues (graph order == ring order == sector order), packed
  // 8×vec3 linear-rgb for the soma + dendrite shaders
  const sectorCols = useMemo(() => {
    const hues = areaHuesOf(colors.palette);
    const arr = new Float32Array(8 * 3);
    for (let k = 0; k < 8; k++) {
      const id = CLUSTER_ORDER[k % CLUSTER_ORDER.length];
      const c = new THREE.Color(hues[id] ?? colors.palette.baseCool);
      arr[k * 3] = c.r; arr[k * 3 + 1] = c.g; arr[k * 3 + 2] = c.b;
    }
    return arr;
  }, [colors]);

  const somaGeo = useMemo(() => buildSomas(), []);
  const arborGeo = useMemo(() => buildArbors(somaGeo.mains, sectorCols), [somaGeo, sectorCols]);
  useEffect(() => () => somaGeo.points.dispose(), [somaGeo]);
  useEffect(() => () => arborGeo.dispose(), [arborGeo]);

  // 8×1 RGBA float: per-sector work (x) + burst envelope (y) - drives soma firing
  // brightness + the dendrite travelling beads
  const actTex = useMemo(() => {
    const tex = new THREE.DataTexture(new Float32Array(8 * 4), 8, 1, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  }, []);
  useEffect(() => () => actTex.dispose(), [actTex]);

  // hot blue-white nucleus colour shared by somas + dendrite roots
  const coreCol = useMemo(() => colors.hub.clone().lerp(colors.baseCool, 0.25), [colors]);

  const somaMat = useMemo(() => makeSomaMaterial(actTex, coreCol, sectorCols), [actTex, coreCol, sectorCols]);
  const arborMat = useMemo(() => makeArborMaterial(actTex, coreCol), [actTex, coreCol]);
  useEffect(() => () => somaMat.dispose(), [somaMat]);
  useEffect(() => {
    arborMat.side = THREE.DoubleSide;
  }, [arborMat]);
  useEffect(() => () => arborMat.dispose(), [arborMat]);

  // the plasma heart - the single legit HDR bloom anchor. A soft billboarded
  // additive glow point (radial falloff to transparent) so it reads as energy
  // bleeding through the front of the web, never a clipped white disc (R16).
  const heartGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array([13]), 1));
    g.setAttribute("aGlow", new THREE.BufferAttribute(new Float32Array([0.78]), 1));
    const c = colors.hub.clone().lerp(colors.baseCool, 0.22);
    g.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array([c.r, c.g, c.b]), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    return g;
  }, [colors]);
  const heartMat = useMemo(() => {
    const m = makeGlowMaterial();
    m.depthTest = false; // always shows through the front of the web
    return m;
  }, []);
  useEffect(() => () => heartMat.dispose(), [heartMat]);
  useEffect(() => () => heartGeo.dispose(), [heartGeo]);

  // NUCLEUS: the core CENTRE rendered as an extreme neuron CLOSE-UP. It is still
  // opaque + DEPTH-WRITING, so it keeps the occluder's structural job (the front
  // hemisphere genuinely occludes the deep-back additive glow) - but its surface
  // is a living glowing CELL MEMBRANE (animated Worley web + organelles + a hot
  // translucent nucleolus + fresnel rim) instead of a dark void. Sized well
  // inside the lumpy soma envelope so the SILHOUETTE stays the connectome and the
  // dendrites cross in front of it. See makeNucleusMaterial in shaders.ts.
  const NUC = 0.36;
  const nucDeep = useMemo(() => colors.bg.clone().lerp(colors.baseCool, 0.18), [colors]);
  const nucleusMat = useMemo(
    () => makeNucleusMaterial(coreCol, colors.baseCool, nucDeep, colors.accent, sectorCols),
    [coreCol, nucDeep, colors, sectorCols],
  );
  useEffect(() => () => nucleusMat.dispose(), [nucleusMat]);

  // tier-1 area node index per sector (graph order == ring order == sector order)
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

  const sectorWork = useRef(new Float32Array(SECTORS));
  const sectorBurst = useRef(new Float32Array(SECTORS));
  const voiceListening = usePraxisStore((s) => s.voiceListening);
  const listenRef = useRef(false);
  listenRef.current = voiceListening;
  const breath = useRef(0.7);
  const talk = useRef(0);
  // Siri-like speaking pulse: smooth scale envelope (1.0 ↔ 1.04) + forward lean
  // driven by rt.voice (0..1), which the runtime already computes from the
  // orchestrator:speaking event envelope. Damped so there are no abrupt jumps.
  const speakScale = useRef(1.0);
  const speakZ = useRef(0.0);
  const listenScale = useRef(1.0);
  const heartRef = useRef<THREE.Points>(null);
  const coreRef = useRef<THREE.Group>(null);
  const somaRef = useRef<THREE.Points>(null);
  const arborRef = useRef<THREE.Mesh>(null);
  // the firing systems bloom (heart here; synapse sparks in FlickerField). The
  // soma + dendrite masses do NOT bloom - bloom flattens form (R16); they read
  // via crisp glow + the additive sparks + heart that DO bloom.
  useBloomTarget(heartRef);

  useFrame((state, delta) => {
    rt.tick(state);
    const t = state.clock.elapsedTime;
    const dt = Math.min(delta, 0.1);

    breath.current += (0.7 + rt.busy * 0.5 - breath.current) * Math.min(1, dt * 2.5);
    talk.current += (rt.talk - talk.current) * Math.min(1, dt * 4);

    // speaking pulse: damp speakScale → (1 + voice*0.04) and speakZ → (voice*0.22)
    // rt.voice is already a smooth 0..1 envelope with syllable cadence - no extra
    // oscillation needed here; MathUtils.damp gives critically-damped feel at 60fps.
    const voiceEnv = rt.voice;
    speakScale.current = THREE.MathUtils.damp(speakScale.current, 1 + voiceEnv * 0.04, 6, dt);
    speakZ.current = THREE.MathUtils.damp(speakZ.current, reduce ? 0 : voiceEnv * 0.22 * R, 6, dt);
    // listening cue: a gentle scale-up while the mic is actively capturing ("I hear you")
    listenScale.current = THREE.MathUtils.damp(listenScale.current, listenRef.current ? 1.025 : 1.0, 8, dt);

    // per-sector work envelope (smoothed) + burst (decaying) → actTex. Driven off
    // rt.activity, which is AMBIENT when idle (mock/synthetic keeps the sectors
    // gently alive) and REAL-driven when live work fires - this is core "heat" glow,
    // deliberately NOT a literal fact, so it does not gate on `synthetic`.
    const data = actTex.image.data as Float32Array;
    const ws = sectorWork.current;
    const bs = sectorBurst.current;
    let maxWork = 0;
    for (let k = 0; k < SECTORS; k++) {
      const idx = areaNode[k];
      let target = 0;
      if (idx >= 0) target = Math.min(1, Math.max(0, rt.activity[idx] - rt.ambient[idx] * 1.2) * 1.8);
      ws[k] += (target - ws[k]) * Math.min(1, dt * 3);
      bs[k] = Math.max(bs[k] * Math.exp(-dt / 0.55), target > 0.3 ? target : 0);
      data[k * 4] = ws[k];
      data[k * 4 + 1] = bs[k];
      if (ws[k] > maxWork) maxWork = ws[k];
    }
    actTex.needsUpdate = true;

    // depth-of-field focus tracks the live camera→focus distance, biased to the
    // FRONT third of the core so the foreground heroes read razor sharp while the
    // back recedes into blur. uModelScale carries the live group scale so soma
    // sizes + dendrite widths track the breath flutter and the journey shrink.
    const camDist = state.camera.position.distanceTo(rt.focusTarget);
    const flutter = 1 + rt.talk * 0.03 + Math.sin(t * 11) * rt.talk * 0.015;
    const journeyShrink = 1 - 0.62 * rt.morph;
    const groupScale = R * flutter * journeyShrink;
    // focus on the FRONT third of the core (heroes there read sharp). The DoF band
    // SCALES with camera distance: tight + dramatic at the close-up (a sharp front
    // soma, the back melting to blur), wide + crisp at the overview (the small core
    // reads whole, not a mush). A fixed world band over-blurred the distant core.
    const focusDist = camDist - 0.4 * groupScale;
    const dofRange = Math.min(30, Math.max(6, camDist * 0.42));

    for (const mat of [somaMat, arborMat]) {
      mat.uniforms.uTime.value = t;
      mat.uniforms.uModelScale.value = groupScale;
      mat.uniforms.uFocusDist.value = focusDist;
      mat.uniforms.uDofRange.value = dofRange;
    }

    // the nucleus membrane lives + fires with the brain's work (R9 heat)
    nucleusMat.uniforms.uTime.value = t;
    nucleusMat.uniforms.uBreath.value = breath.current;
    nucleusMat.uniforms.uTalk.value = talk.current;
    nucleusMat.uniforms.uWork.value = Math.min(1, maxWork * 0.9 + rt.busy * 0.4);

    // heart glow breathes + flares on activity, hard-capped so it never clips (R16)
    const glowAttr = heartGeo.getAttribute("aGlow") as THREE.BufferAttribute;
    glowAttr.setX(0, Math.min(0.96, 0.7 + Math.sin(t * 0.55) * 0.08 + rt.busy * 0.3 + rt.talk * 0.4));
    glowAttr.needsUpdate = true;

    // slow internal tumble (OBJECT rotation, not a camera orbit - R2) so fresh
    // structure rotates into view and the parallax keeps revealing the volume. In
    // journey mode the core shrinks to a modest NOW anchor (journeyShrink).
    if (coreRef.current) {
      // speakScale: whole-brain Siri-like breath on top of the existing groupScale.
      // speakZ: gentle lean toward the camera while speaking (reduced-motion = no push).
      coreRef.current.scale.setScalar(groupScale * speakScale.current * listenScale.current);
      coreRef.current.position.z = speakZ.current;
      if (reduce) {
        coreRef.current.rotation.set(0.16, -0.5, 0.02);
      } else {
        coreRef.current.rotation.y = t * 0.045;
        coreRef.current.rotation.x = 0.14 + Math.sin(t * 0.043) * 0.06;
      }
    }
  });

  // keep the soma Points from being frustum-culled by its tiny local bounds
  useLayoutEffect(() => {
    if (somaRef.current) somaRef.current.frustumCulled = false;
    if (arborRef.current) arborRef.current.frustumCulled = false;
  }, []);

  return (
    <group ref={coreRef} scale={R}>
      {/* the NUCLEUS - neuron-close-up cell membrane; opaque + depth-writing so
          it swallows the deep-back (front hemisphere genuinely occludes the
          back) while its surface reads as living glowing tissue, not a void */}
      <mesh
        renderOrder={0}
        scale={[CORE_AXES.x * NUC, CORE_AXES.y * NUC, CORE_AXES.z * NUC]}
        material={nucleusMat}
      >
        <sphereGeometry args={[1, 64, 48]} />
      </mesh>
      {/* the dominant branching dendrite web (camera-facing tapered ribbons) */}
      <mesh ref={arborRef} geometry={arborGeo} material={arborMat} renderOrder={1} />
      {/* the glowing somas (bright nucleus + soft halo, depth-of-field graded) */}
      <points ref={somaRef} geometry={somaGeo.points} material={somaMat} renderOrder={2} />
      {/* plasma heart - a soft point of energy bleeding through the front */}
      <points ref={heartRef} geometry={heartGeo} material={heartMat} renderOrder={3} frustumCulled={false} />
    </group>
  );
}
