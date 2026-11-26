/**
 * AgentField - the live agents, as IDENTIFIABLE entities doing REAL, routed work
 * (spec: agents must read as real agents, NOT anonymous flying lights; r3-lock R10).
 *
 * Each agent is its insignia GLYPH in a state-coloured ring, named while it works,
 * with a thin TETHER to the task it's firing on - so "which agent is on which
 * cluster" reads at a glance. Three things make it read as WORK, not decoration:
 *
 *  1. TRAVEL - when an agent takes a task it flies in to that cluster's medallion
 *     then rides the branch out to the task (runtime route), leaving a COMET TRAIL
 *     along the connectome. You see it journey to its lobe.
 *  2. HANDOFF - when one agent feeds another, an information packet streaks along
 *     the edge between the two chips (motion along the edge, spec §3).
 *  3. DOCK - idle agents dim and park in a neat arc below the core (spec §4).
 *
 * All motion is driven by eventBus activity. Per spec A.2 (2026-07-06): TRAVEL +
 * DOCK-vs-ORBIT state (the `working` flag below) is gated on `ag.real` - true only
 * for agent:status events that came from the real-event bridge / Hermes, never the
 * mock timeline's decorative filler. An agent with no real work stays docked and
 * dim even if the mock is playing, so idle reads honestly calm. Transforms +
 * additive opacity only → 60fps on WebView2.
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import { useRuntime, useThemeColors } from "./context";
import { TRAIL_LEN } from "./runtime";
import { usePraxisStore } from "@/store/usePraxisStore";
import { AGENT_GLYPH, makeGlyphSprite } from "@/glyphs/glyphs";
import { makeGlowMaterial } from "./shaders";
import { useBloomTarget } from "./bloomSelection";

const LABEL_FONT = "/fonts/praxis.ttf";
const CHIP = 1.7;
const TRAIL_HEAD = 12; // comet head point size (tapers down the tail)
const HANDOFF_BEADS = 6; // beads per handoff packet (head + tail)
const HANDOFF_HEAD = 11;
type TroikaText = THREE.Object3D & { fillOpacity: number; outlineOpacity: number };

export function AgentField() {
  const rt = useRuntime();
  const colors = useThemeColors();
  const nAgents = rt.agents.length;
  const nHandoff = rt.hBright.length;

  // insignia baked in white → tinted live by state via the sprite material color.
  // 384px + trilinear mips + anisotropy: the insignia stays a crisp, identifiable mark
  // (not a soft smudge) as the chip travels toward camera and scales - the "agents need
  // real visual improvement" bump. Infra agents get no chip, but building their texture
  // is harmless (index alignment stays 1:1 with rt.agents; it's just never rendered).
  const texes = useMemo(
    () =>
      rt.agents.map((a) => {
        const tex = new THREE.CanvasTexture(
          makeGlyphSprite(AGENT_GLYPH[a.id] ?? "hex", "#ffffff", { size: 384, glow: true, weight: 2.1 }),
        );
        tex.anisotropy = 8;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = true;
        return tex;
      }),
    [rt],
  );
  useEffect(() => () => texes.forEach((t) => t.dispose()), [texes]);

  const ringGeo = useMemo(() => new THREE.RingGeometry(0.95, 1.12, 40), []);
  useEffect(() => () => ringGeo.dispose(), [ringGeo]);
  // orbit-spark ARC - not a second circle (the owner killed that): a short, thin,
  // model-tinted arc that SWEEPS around the chip rim while the agent works, like
  // a scanner trace. Motion carries the "alive" read; idle chips stay clean.
  const ringInnerGeo = useMemo(() => new THREE.RingGeometry(1.18, 1.24, 24, 1, 0, 1.15), []);
  useEffect(() => () => ringInnerGeo.dispose(), [ringInnerGeo]);

  // (no agent→task "leash" line - a working agent ORBITS its task instead; the orbital
  // motion + the lit branch under it carry the bond. The owner disliked the tether line.)

  // comet trails - one additive-glow Points cloud, TRAIL_LEN beads per agent,
  // head bright → tail transparent, brightness gated on how fast the agent moves
  // (parked idle agents leave none, a travelling agent leaves a streak)
  const trailGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const n = nAgents * TRAIL_LEN;
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute("aGlow", new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    return g;
  }, [nAgents]);
  const trailMat = useMemo(() => makeGlowMaterial(), []);
  useEffect(() => () => trailGeo.dispose(), [trailGeo]);
  useEffect(() => () => trailMat.dispose(), [trailMat]);

  // handoff packets - a bead string riding the bowed arc between two chips
  const handoffGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const n = nHandoff * HANDOFF_BEADS;
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute("aGlow", new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    return g;
  }, [nHandoff]);
  const handoffMat = useMemo(() => makeGlowMaterial(), []);
  useEffect(() => () => handoffGeo.dispose(), [handoffGeo]);
  useEffect(() => () => handoffMat.dispose(), [handoffMat]);

  const groupRefs = useRef<(THREE.Group | null)[]>([]);
  const spriteMatRefs = useRef<(THREE.SpriteMaterial | null)[]>([]);
  const ringRefs = useRef<(THREE.Mesh | null)[]>([]);
  const ringInnerRefs = useRef<(THREE.Mesh | null)[]>([]);
  const ringInnerMatRefs = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const ringMatRefs = useRef<(THREE.MeshBasicMaterial | null)[]>([]);
  const nameRefs = useRef<(TroikaText | null)[]>([]);
  const trailRef = useRef<THREE.Points>(null);
  const handoffRef = useRef<THREE.Points>(null);
  const color = useMemo(() => new THREE.Color(), []);
  const scratchT = useMemo(() => new THREE.Color(), []);
  const hColor = useMemo(() => new THREE.Color(), []);

  // soft CORE GLOW - one additive point per agent behind its insignia, model-tinted,
  // breathing. Turns the flat "circle with a glow" into a luminous little body.
  const coreGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(nAgents * 3), 3));
    g.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(nAgents), 1));
    g.setAttribute("aGlow", new THREE.BufferAttribute(new Float32Array(nAgents), 1));
    g.setAttribute("aColor", new THREE.BufferAttribute(new Float32Array(nAgents * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    return g;
  }, [nAgents]);
  const coreMat = useMemo(() => makeGlowMaterial(), []);
  const coreRef = useRef<THREE.Points>(null);
  useEffect(() => () => coreGeo.dispose(), [coreGeo]);
  useEffect(() => () => coreMat.dispose(), [coreMat]);
  // handoff arc scratch (recomputed from live chip positions - matches runtime)
  const arc = useMemo(() => ({ ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, mx: 0, my: 0, mz: 0 }), []);

  useBloomTarget(trailRef); // the comet streaks bloom
  useBloomTarget(handoffRef); // the info packets bloom
  useBloomTarget(coreRef); // the chip core glow blooms

  useFrame((state) => {
    rt.tick(state);
    const q = state.camera.quaternion;
    const st = usePraxisStore.getState();
    const selId = st.selectedId;

    const trPos = trailGeo.getAttribute("position").array as Float32Array;
    const trSize = trailGeo.getAttribute("aSize").array as Float32Array;
    const trGlow = trailGeo.getAttribute("aGlow").array as Float32Array;
    const trCol = trailGeo.getAttribute("aColor") as THREE.BufferAttribute;

    for (let i = 0; i < nAgents; i++) {
      const ag = rt.agents[i];
      // INFRA agents (Hermes brain engine + Relay/Ledger plumbing) are NOT peripheral
      // orbiting chips - Hermes lives at the core. Zero out any GPU contribution for
      // their slot (core glow + comet trail) and skip; their JSX chip isn't rendered.
      if (ag.infra) {
        const czi = coreGeo.getAttribute("aSize") as THREE.BufferAttribute;
        czi.setX(i, 0);
        const cgl = coreGeo.getAttribute("aGlow") as THREE.BufferAttribute;
        cgl.setX(i, 0);
        const base = i * TRAIL_LEN;
        for (let s = 0; s < TRAIL_LEN; s++) trSize[base + s] = 0;
        continue;
      }
      const g = groupRefs.current[i];
      const traveling = ag.transit >= 0;
      // "working" (the visible orbit + hot chip + name) is real work ONLY (spec A.2):
      // ag.real is false for the mock timeline's decorative filler, so idle stays
      // honestly calm instead of orbiting a fabricated "agent working on X".
      const working = ag.attachTask >= 0 && ag.real;
      const selected = selId === ag.id;

      // colour = model IDENTITY (hue) × work-STATE (luminance). A working agent
      // glows its model's signature hue toward the hot heart; idle dims to cool but
      // keeps a hint of its model. No known model → the theme accent (unchanged look).
      const mc = ag.modelCol;
      if (working) {
        if (mc) color.copy(mc).lerp(colors.hub, 0.24 + ag.intensity * 0.42);
        else color.copy(colors.accent).lerp(colors.hub, ag.intensity * 0.5);
      } else {
        color.copy(colors.baseCool).lerp(colors.hub, 0.1);
        if (mc) color.lerp(mc, 0.3);
      }

      if (g) {
        g.position.set(ag.pos.x, ag.pos.y, ag.pos.z);
        const s = (working ? 1 : 0.78) * (selected ? 1.18 : 1);
        g.scale.setScalar(s);
      }
      // billboard the chip ring with its glyph sprite - a plane-locked ring under
      // the fixed camera tilt reads as an off-centre ellipse around the insignia
      // ("circles with a slight offset"); facing the camera keeps them concentric.
      const ringMesh = ringRefs.current[i];
      if (ringMesh) ringMesh.quaternion.copy(q);
      const ringInner = ringInnerRefs.current[i];
      if (ringInner) {
        // billboard, then spin the arc around the rim - fast sweep while working,
        // barely-drifting when idle (motion = life, no extra static geometry)
        ringInner.quaternion.copy(q);
        ringInner.rotateZ(-(state.clock.elapsedTime) * (working ? 2.4 : 0.25) - i * 1.7);
        ringInner.visible = working || ag.transit >= 0;
      }
      const rim = ringInnerMatRefs.current[i];
      if (rim) {
        if (mc) rim.color.copy(mc);
        else rim.color.copy(colors.baseCool);
        rim.opacity = (working ? 0.75 : 0.3) + ag.intensity * 0.25;
      }
      // a faint breath on DOCKED agents so the idle bay reads alive, not dead
      const breath = working ? 0 : 0.07 * (0.5 + 0.5 * Math.sin(ag.phase * 0.9 + i));

      // core glow behind the insignia - model-tinted, breathing, hotter when working
      {
        const cg = coreGeo;
        const cpos = cg.getAttribute("position") as THREE.BufferAttribute;
        const csz = cg.getAttribute("aSize") as THREE.BufferAttribute;
        const cgl = cg.getAttribute("aGlow") as THREE.BufferAttribute;
        const ccl = cg.getAttribute("aColor") as THREE.BufferAttribute;
        cpos.setXYZ(i, ag.pos.x, ag.pos.y, ag.pos.z + 0.02);
        const pulse = 0.85 + 0.15 * Math.sin(state.clock.elapsedTime * 2.2 + i);
        csz.setX(i, (working ? 9.5 : 6) * pulse * (selected ? 1.25 : 1));
        cgl.setX(i, (working ? 0.9 : 0.32) + ag.intensity * 0.5 + breath);
        scratchT.copy(color).lerp(colors.hub, working ? 0.35 : 0.12);
        ccl.setXYZ(i, scratchT.r, scratchT.g, scratchT.b);
      }
      const sm = spriteMatRefs.current[i];
      if (sm) {
        sm.color.copy(color);
        sm.opacity = (working ? 0.85 : 0.42) + ag.intensity * 0.4 + breath + (selected ? 0.2 : 0);
      }
      const rm = ringMatRefs.current[i];
      if (rm) {
        rm.color.copy(color);
        rm.opacity = (working ? 0.45 : 0.18) + ag.intensity * 0.55 + breath + (selected ? 0.3 : 0);
      }
      const nm = nameRefs.current[i];
      if (nm) {
        // named while it works OR travels (so you read WHO is heading WHERE)
        const op = working ? THREE.MathUtils.clamp(ag.intensity, 0, 1) : selected ? 0.9 : 0;
        nm.visible = op > 0.02;
        nm.fillOpacity = op;
        nm.outlineOpacity = op * 0.85;
        nm.position.set(ag.pos.x, ag.pos.y - CHIP * 0.95, ag.pos.z);
        nm.quaternion.copy(q);
      }

      // (tether removed - the agent orbits its task; the comet trail + lit branch carry it)

      // --- comet trail ---
      const head = ag.trailHead;
      const prev = (head - 1 + TRAIL_LEN) % TRAIL_LEN;
      // per-frame speed proxy → a parked agent leaves no streak, a traveller does
      const dxh = ag.trail[head * 3] - ag.trail[prev * 3];
      const dyh = ag.trail[head * 3 + 1] - ag.trail[prev * 3 + 1];
      const dzh = ag.trail[head * 3 + 2] - ag.trail[prev * 3 + 2];
      const speed = Math.sqrt(dxh * dxh + dyh * dyh + dzh * dzh);
      const gain = THREE.MathUtils.clamp(speed * 3.2, 0, 1) * (0.32 + 0.78 * ag.intensity);
      const base = i * TRAIL_LEN;
      for (let s = 0; s < TRAIL_LEN; s++) {
        const ring = (head - s + TRAIL_LEN) % TRAIL_LEN;
        const age = s / (TRAIL_LEN - 1); // 0 = head, 1 = oldest
        // smoother taper (pow 1.6) → a soft, tapering comet instead of a hard blob;
        // the head runs hot (toward the core white), the tail settles to model hue
        const taper = Math.pow(1 - age, 1.6);
        const vi = base + s;
        trPos[vi * 3] = ag.trail[ring * 3];
        trPos[vi * 3 + 1] = ag.trail[ring * 3 + 1];
        trPos[vi * 3 + 2] = ag.trail[ring * 3 + 2];
        trSize[vi] = TRAIL_HEAD * (0.12 + 0.88 * taper);
        trGlow[vi] = gain * taper * 1.45;
        scratchT.copy(color).lerp(colors.hub, (1 - age) * 0.45); // hot head
        trCol.setXYZ(vi, scratchT.r, scratchT.g, scratchT.b);
      }
    }
    trailGeo.getAttribute("position").needsUpdate = true;
    trailGeo.getAttribute("aSize").needsUpdate = true;
    trailGeo.getAttribute("aGlow").needsUpdate = true;
    trCol.needsUpdate = true;
    coreGeo.getAttribute("position").needsUpdate = true;
    coreGeo.getAttribute("aSize").needsUpdate = true;
    coreGeo.getAttribute("aGlow").needsUpdate = true;
    coreGeo.getAttribute("aColor").needsUpdate = true;

    // --- handoff packets: a bead string riding the bowed arc between two chips ---
    const hPos = handoffGeo.getAttribute("position").array as Float32Array;
    const hSize = handoffGeo.getAttribute("aSize").array as Float32Array;
    const hGlow = handoffGeo.getAttribute("aGlow").array as Float32Array;
    const hCol = handoffGeo.getAttribute("aColor") as THREE.BufferAttribute;
    // "information" hue - cool white, distinct from the warm work pulses
    hColor.copy(colors.baseCool).lerp(colors.hub, 0.5);
    for (let h = 0; h < nHandoff; h++) {
      const bBase = h * HANDOFF_BEADS;
      const bright = rt.hBright[h];
      const from = rt.agents[rt.hFrom[h]];
      const to = rt.agents[rt.hTo[h]];
      if (rt.hIntensity[h] <= 0.001 || bright <= 0.001 || !from || !to) {
        for (let k = 0; k < HANDOFF_BEADS; k++) hSize[bBase + k] = 0;
        continue;
      }
      // rebuild the same bowed quadratic the runtime integrates (A→M→B)
      arc.ax = from.pos.x; arc.ay = from.pos.y; arc.az = from.pos.z;
      arc.bx = to.pos.x; arc.by = to.pos.y; arc.bz = to.pos.z;
      const ddx = arc.bx - arc.ax, ddy = arc.by - arc.ay;
      const planar = Math.hypot(ddx, ddy) || 1;
      const len = Math.hypot(ddx, ddy, arc.bz - arc.az) || 1;
      const bow = Math.min(len * 0.22, 3.2);
      arc.mx = (arc.ax + arc.bx) * 0.5 + (-ddy / planar) * bow;
      arc.my = (arc.ay + arc.by) * 0.5 + (ddx / planar) * bow;
      arc.mz = (arc.az + arc.bz) * 0.5 + Math.min(len * 0.12, 2.0) + 1.0;
      const p = rt.hProg[h];
      for (let k = 0; k < HANDOFF_BEADS; k++) {
        const bi = bBase + k;
        const tt = Math.max(0, p - k * 0.05); // head + trailing tail
        const mt = 1 - tt;
        const w0 = mt * mt, w1 = 2 * mt * tt, w2 = tt * tt;
        hPos[bi * 3] = w0 * arc.ax + w1 * arc.mx + w2 * arc.bx;
        hPos[bi * 3 + 1] = w0 * arc.ay + w1 * arc.my + w2 * arc.by;
        hPos[bi * 3 + 2] = w0 * arc.az + w1 * arc.mz + w2 * arc.bz;
        const fall = 1 - k / HANDOFF_BEADS;
        hSize[bi] = HANDOFF_HEAD * (0.4 + 0.6 * fall);
        hGlow[bi] = bright * fall * 1.5;
        hCol.setXYZ(bi, hColor.r, hColor.g, hColor.b);
      }
    }
    handoffGeo.getAttribute("position").needsUpdate = true;
    handoffGeo.getAttribute("aSize").needsUpdate = true;
    handoffGeo.getAttribute("aGlow").needsUpdate = true;
    hCol.needsUpdate = true;
  });

  const pick = (i: number, e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const ag = rt.agents[i];
    const st = usePraxisStore.getState();
    if (ag.attachTask >= 0) st.focus(rt.nodes[ag.attachTask]?.id ?? null);
  };
  const hover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    document.body.style.cursor = "pointer";
  };
  const out = () => {
    document.body.style.cursor = "auto";
  };

  return (
    <group>
      <points ref={coreRef} geometry={coreGeo} material={coreMat} frustumCulled={false} />
      <points ref={trailRef} geometry={trailGeo} material={trailMat} frustumCulled={false} />
      <points ref={handoffRef} geometry={handoffGeo} material={handoffMat} frustumCulled={false} />
      {rt.agents.map((ag, i) =>
        ag.infra ? null : (
        <group key={ag.id} ref={(r) => (groupRefs.current[i] = r)}>
          <mesh geometry={ringGeo} ref={(r) => (ringRefs.current[i] = r)}>
            <meshBasicMaterial
              ref={(r) => (ringMatRefs.current[i] = r)}
              transparent
              opacity={0.3}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
              toneMapped={false}
              side={THREE.DoubleSide}
            />
          </mesh>
          <mesh geometry={ringInnerGeo} ref={(r) => (ringInnerRefs.current[i] = r)}>
            <meshBasicMaterial
              ref={(r) => (ringInnerMatRefs.current[i] = r)}
              transparent
              opacity={0.25}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
              toneMapped={false}
              side={THREE.DoubleSide}
            />
          </mesh>
          <sprite
            scale={[CHIP, CHIP, CHIP]}
            onClick={(e) => pick(i, e)}
            onPointerOver={hover}
            onPointerOut={out}
          >
            <spriteMaterial
              ref={(r) => (spriteMatRefs.current[i] = r)}
              map={texes[i]}
              transparent
              depthWrite={false}
              depthTest={false}
              toneMapped={false}
            />
          </sprite>
        </group>
      ),
      )}
      {rt.agents.map((ag, i) =>
        ag.infra ? null : (
        <Text
          key={`${ag.id}-name`}
          ref={(r) => (nameRefs.current[i] = r as unknown as TroikaText)}
          font={LABEL_FONT}
          fontSize={0.5}
          color={colors.palette.text}
          anchorX="center"
          anchorY="top"
          outlineWidth={0.02}
          outlineColor={colors.palette.bgDeep}
          material-toneMapped={false}
          material-depthTest={false}
          material-transparent
          renderOrder={21}
          letterSpacing={0.04}
        >
          {ag.name}
        </Text>
      ),
      )}
    </group>
  );
}
