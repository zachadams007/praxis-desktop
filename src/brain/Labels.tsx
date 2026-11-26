/**
 * Labels - billboarded troika text that SPREADS to never overlap (rebuilt
 * 2026-06-16). The owner's standing note: labels must be readable and laid out like a
 * notebook - never piled on each other, never just culled.
 *
 *   - CLUSTER labels sit radially OUTSIDE their medallion on an accent LEADER.
 *   - TASK / DETAIL labels use a screen-space DE-COLLISION that DISPLACES a
 *     colliding label vertically into free space (with a thin leader back to its
 *     node) instead of hiding it - so a focused cluster's tasks read as a clean
 *     stacked column, not a pile. A label only hides if it can't fit at all.
 *   - When a cluster is focused, OTHER clusters' task labels drop out entirely so
 *     the focused tree is uncluttered; detail (tier-3) labels only appear once
 *     you're close (high LOD), so the cluster framing shows task names, not soup.
 *
 * Positions are re-read from the runtime every frame, so labels ride their nodes
 * through the brain⇄journey morph. Font is bundled locally (`/fonts/praxis.ttf`).
 */

import { Component, Suspense, useMemo, useRef, type ReactNode } from "react";
import { useFrame } from "@react-three/fiber";
import { Text } from "@react-three/drei";
import * as THREE from "three";
import { useRuntime, useThemeColors } from "./context";
import { LABEL_FONTS, useLabelFont } from "./labelFontStore";
import { usePraxisStore } from "@/store/usePraxisStore";
import { buildGraph } from "@/data/graph";
import { areaHuesOf } from "@/theme/tokens";

const LABEL_FONT = "/fonts/praxis.ttf";
// cluster names + stats wear the DATA voice (IBM Plex Mono, converted from our
// vendored OFL woff2s) so the scene typography matches the dashboards exactly -
// The owner didn't love the rounded praxis.ttf on the big cluster caps.
const CLUSTER_FONT = "/fonts/ibm-plex-mono-600.ttf";
const CLUSTER_STAT_FONT = "/fonts/ibm-plex-mono-500.ttf";
const CLUSTER_LABEL_OUT = 5.9; // medallion centre → label centre - MUST clear the
// progress arc (r 2.46) + knot glow with margin; 4.7 had PRAXIS/FINANCE names
// sitting on their rings (the owner round-4 catch)
const MAX_PUSH_NDC = 0.62; // furthest a label may be displaced to clear (NDC units)

type TroikaText = THREE.Object3D & { fillOpacity: number; outlineOpacity: number };

interface LabelDesc {
  idx: number;
  text: string;
  tier: number;
  fontSize: number;
  offsetY: number;
  accent: THREE.Color;
  plan?: string;
  planActive?: boolean;
  planDone?: boolean;
}

function planLine(status?: string, eta?: string): string | undefined {
  if (!status) return undefined;
  if (status === "done") return "done";
  if (status === "active") return eta ? `now · ${eta}` : "now";
  return eta ?? status;
}

/**
 * A label/font failure must NEVER take down the brain window. 2026-07-10 wedge:
 * a .woff2 cluster font threw inside troika, the choice was already persisted, and
 * every watchdog reload re-crashed the mount - grey window until the key was hand
 * cleared. This boundary contains the crash, resets the cycler to the known-good
 * default, FORGETS the persisted choice, and remounts the label layer once. If the
 * default itself fails (impossible short of a corrupted bundle) it stays dark -
 * brain alive, labels off - instead of looping.
 */
class LabelsErrorBoundary extends Component<{ children: ReactNode }, { dead: boolean; epoch: number }> {
  state = { dead: false, epoch: 0 };
  static getDerivedStateFromError() {
    return { dead: true };
  }
  componentDidCatch(e: Error) {
    console.warn("[Labels] contained label-layer crash:", e?.message);
    const st = useLabelFont.getState();
    if (st.font.id !== LABEL_FONTS[0].id) {
      st.reset();
      setTimeout(() => this.setState((s) => ({ dead: false, epoch: s.epoch + 1 })), 0);
    }
  }
  render() {
    return this.state.dead ? null : <group key={this.state.epoch}>{this.props.children}</group>;
  }
}

export function Labels() {
  return (
    <LabelsErrorBoundary>
      <LabelsInner />
    </LabelsErrorBoundary>
  );
}

function LabelsInner() {
  const rt = useRuntime();
  const colors = useThemeColors();
  const graphVersion = usePraxisStore((s) => s.graphVersion);
  const hues = useMemo(() => areaHuesOf(colors.palette), [colors.palette]);
  // live cluster-label typeface (cycled from the Controls tab; localStorage-persisted)
  const clusterFont = useLabelFont((s) => s.font);

  const labels = useMemo<LabelDesc[]>(() => {
    const out: LabelDesc[] = [];
    for (let i = 0; i < rt.n; i++) {
      const node = rt.nodes[i];
      if (!node) continue;
      const tier = rt.tier[i];
      if (tier === 0) continue; // R6: the core needs no caption
      const fontSize = tier === 1 ? 1.0 : tier === 2 ? 0.62 : 0.4;
      const offsetY = node.size * 1.5 + fontSize * 0.5;
      const hex = node.areaId ? hues[node.areaId] : undefined;
      out.push({
        idx: i,
        // cluster names read as tracked caps (the LEARNING AI treatment) - the
        // stats sub-line beneath carries the live numbers
        text: tier === 1 ? node.label.toUpperCase() : node.label,
        tier,
        fontSize,
        offsetY,
        accent: new THREE.Color(hex ?? colors.palette.baseCool),
        plan: tier === 2 ? planLine(node.status, node.eta) : undefined,
        planActive: node.status === "active",
        planDone: node.status === "done",
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt, graphVersion, hues, colors.palette.baseCool]);

  const refs = useRef<(TroikaText | null)[]>([]);
  const planRefs = useRef<(TroikaText | null)[]>([]);
  // cluster stats sub-line (tier-1 only): "N TASKS · M ACTIVE" / "K FIRING",
  // recomputed ~1Hz from the REAL store + graph - never decorative numbers.
  const statRefs = useRef<(TroikaText | null)[]>([]);
  const statText = useRef<string[]>([]);
  const camPos = useMemo(() => new THREE.Vector3(), []);
  const collide = useRef<Float32Array | null>(null); // eased visibility 0..1
  const pushCur = useRef<Float32Array | null>(null); // eased world-Y displacement
  const pushTgt = useRef<Float32Array | null>(null); // target world-Y displacement
  const frameNo = useRef(0);
  const agentTasksRef = useRef<Set<number>>(new Set()); // reused each frame (no per-frame alloc)
  const proj = useMemo(() => new THREE.Vector3(), []);
  const outward = useMemo(() => new THREE.Vector2(), []);

  // ---- cluster leader lines (one per tier-1 label) ----
  const clusterLabelIdx = useMemo(
    () => labels.map((l, i) => (l.tier === 1 ? i : -1)).filter((i) => i >= 0),
    [labels],
  );
  const leaderGeo = useMemo(() => {
    const n = clusterLabelIdx.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    return g;
  }, [clusterLabelIdx.length]);
  const leaderMat = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );

  // ---- task/detail leader lines (drawn only when a label is displaced) ----
  const taskLeaderGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(labels.length * 2 * 3), 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    return g;
  }, [labels.length]);
  const taskLeaderMat = useMemo(
    () =>
      new THREE.LineBasicMaterial({
        color: colors.palette.textDim,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
      }),
    [colors.palette.textDim],
  );

  useFrame((state, delta) => {
    rt.tick(state);
    const q = state.camera.quaternion;
    const jm = rt.morph;
    state.camera.getWorldPosition(camPos);
    const st = usePraxisStore.getState();
    const selIdx = st.selectedId ? rt.index.get(st.selectedId) ?? -1 : -1;
    const hovIdx = st.hoverId ? rt.index.get(st.hoverId) ?? -1 : -1;
    const focusIdx = st.focusId ? rt.index.get(st.focusId) ?? -1 : -1;
    const inspectedTask = focusIdx >= 0 && rt.tier[focusIdx] === 2
      ? focusIdx
      : selIdx >= 0 && rt.tier[selIdx] === 2
        ? selIdx
        : -1;

    let focusArea = -1;
    if (selIdx >= 0) focusArea = rt.tier[selIdx] === 1 ? selIdx : rt.areaIndex[selIdx];
    else if (hovIdx >= 0) focusArea = rt.tier[hovIdx] === 1 ? hovIdx : rt.areaIndex[hovIdx];

    // tasks an agent is orbiting → their labels are ALWAYS shown (skip LOD + de-collision),
    // so the agent visibly orbits a named task at any zoom. Reuse a persistent Set (was
    // allocating a fresh Set every frame).
    const agentTasks = agentTasksRef.current;
    agentTasks.clear();
    // A real agent force-reveals its node (spec A.2), so real-forced labels always sit on a
    // visible soma. Infra agents (Hermes/Relay/Ledger) have no chip and never force either.
    for (const ag of rt.agents) if (!ag.infra && ag.real && ag.attachTask >= 0) agentTasks.add(ag.attachTask);

    if (!collide.current || collide.current.length < labels.length) {
      collide.current = new Float32Array(labels.length).fill(1);
      pushCur.current = new Float32Array(labels.length);
      pushTgt.current = new Float32Array(labels.length);
    }
    const col = collide.current;
    const pc = pushCur.current!;
    const pt = pushTgt.current!;

    frameNo.current++;
    const runCollision = frameNo.current % 3 === 0;
    interface Rect { x: number; y: number; hw: number; hh: number }
    const cam = state.camera as THREE.PerspectiveCamera;
    const tanF = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
    // Preserve a stable reading size while the Journey overview pulls back to
    // fit the full history/future span. Collision geometry uses the same scale,
    // so larger labels are displaced into free space instead of overlapping.
    const journeyTaskScale = 1 + jm * (
      THREE.MathUtils.clamp(camPos.distanceTo(rt.focusTarget) / 75, 1, 1.75) - 1
    );

    // base opacity by tier/LOD/distance (clusters handled separately below)
    const baseOp = (i: number): number => {
      const { idx, tier } = labels[i];
      if (agentTasks.has(idx)) return 1; // agent-orbited task → label always on
      const rev = rt.reveal[idx];
      // detail (tier-3) labels only appear once you're genuinely close - keeps the
      // cluster framing showing TASK names, not a detail-leaf soup
      let op = tier === 2 ? THREE.MathUtils.clamp((rev - 0.4) / 0.4, 0, 1)
        : THREE.MathUtils.clamp((rev - 0.9) / 0.1, 0, 1);
      const dx = rt.pos[idx * 3] - camPos.x;
      const dy = rt.pos[idx * 3 + 1] - camPos.y;
      const dz = rt.pos[idx * 3 + 2] - camPos.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      op *= THREE.MathUtils.clamp((dist - 6) / 5, 0, 1);
      // Journey is a roadmap, so tier-2 labels remain readable across the full
      // fitted map. Distance fading here used to erase the outer history/future
      // labels as soon as the camera pulled back far enough to fit those nodes.
      // (no activity-based dimming - a whole zoom level reveals UNIFORMLY, never a
      // heat-graded subset where some same-level tasks read and others don't)
      // when a cluster is focused, OTHER clusters' task labels drop out so the
      // focused tree reads clean (was a weak 0.4 dim → still cluttered)
      if (focusArea >= 0 && tier >= 2 && rt.areaIndex[idx] !== focusArea) op *= 0.0;
      // A single-task drill is a reading surface for that task and its artifacts.
      // Sibling milestone labels otherwise balloon at close range and obscure the
      // inspected node or disappear beneath the dock.
      if (inspectedTask >= 0 && tier === 2 && idx !== inspectedTask) op = 0;
      return op;
    };

    // distance from camera to a world point (for the NDC↔world push mapping)
    const distTo = (x: number, y: number, z: number) =>
      Math.sqrt((x - camPos.x) ** 2 + (y - camPos.y) ** 2 + (z - camPos.z) ** 2);

    if (runCollision) {
      const kept: Rect[] = [];
      // seed with CLUSTER labels (pre-spread, always win → blockers). BOTH the name
      // cap AND its stats sub-line ("N NODES · M/K DONE") are seeded, so task + agent
      // labels route AROUND the whole two-line cluster block - the old bug seeded only
      // the name, letting the stats line land on a first-milestone task label (FINANCE
      // "N NODES" over "Budget guardrails", STUDIO over "Posting automation").
      for (let ci = 0; ci < labels.length; ci++) {
        if (labels[ci].tier !== 1) continue;
        const cpx = rt.pos[labels[ci].idx * 3];
        const cpy = rt.pos[labels[ci].idx * 3 + 1];
        const cpz = rt.pos[labels[ci].idx * 3 + 2];
        const clen = Math.hypot(cpx, cpy) || 1;
        const ox = cpx / clen;
        const oy = cpy / clen;
        const lx = cpx + ox * CLUSTER_LABEL_OUT;
        const ly = cpy + oy * CLUSTER_LABEL_OUT + (oy >= 0 ? 0.3 : -0.3);
        // --- name cap ---
        proj.set(lx, ly, cpz);
        const cdist = distTo(proj.x, proj.y, proj.z);
        proj.project(cam);
        if (proj.z > 1 || proj.z < -1) continue;
        const nameHh = (labels[ci].fontSize * 0.78) / (cdist * tanF);
        kept.push({
          x: proj.x,
          y: proj.y,
          hw: (labels[ci].text.length * labels[ci].fontSize * 0.27) / (cdist * tanF * cam.aspect),
          hh: nameHh,
        });
        // --- stats sub-line (world-anchored 0.26 below the name, IBM Plex 0.46) ---
        // seed it as its own blocker using the LIVE stat text width so the box is
        // exactly as wide as what renders (never a stale/decorative estimate).
        const statTxt = statText.current[ci] || "";
        if (statTxt) {
          proj.set(lx, ly - 0.26, cpz);
          proj.project(cam);
          if (proj.z <= 1 && proj.z >= -1) {
            kept.push({
              x: proj.x,
              y: proj.y,
              hw: (statTxt.length * 0.46 * 0.27) / (cdist * tanF * cam.aspect),
              hh: (0.46 * 0.78) / (cdist * tanF),
            });
          }
        }
      }

      // task/detail labels, priority order (focused area → tier → activity)
      const order: number[] = [];
      for (let i = 0; i < labels.length; i++) if (labels[i].tier >= 2 && baseOp(i) >= 0.05) order.push(i);
      order.sort((a, b) => {
        // agent-orbited tasks win outright - they're placed first + become blockers others
        // route around, so an agent's task label is never the one that gets culled.
        const aa = agentTasks.has(labels[a].idx) ? -1000 : 0;
        const ab = agentTasks.has(labels[b].idx) ? -1000 : 0;
        const fa = focusArea >= 0 && rt.areaIndex[labels[a].idx] === focusArea ? -100 : 0;
        const fb = focusArea >= 0 && rt.areaIndex[labels[b].idx] === focusArea ? -100 : 0;
        const pa = aa + fa + labels[a].tier * 10 - rt.activity[labels[a].idx] * 4;
        const pb = ab + fb + labels[b].tier * 10 - rt.activity[labels[b].idx] * 4;
        return pa - pb;
      });

      const overlaps = (x: number, y: number, hw: number, hh: number) => {
        for (const r of kept) {
          if (Math.abs(x - r.x) < (hw + r.hw) * 1.12 && Math.abs(y - r.y) < (hh + r.hh) * 1.18) return r;
        }
        return null;
      };

      for (const i of order) {
        const { idx, fontSize, text } = labels[i];
        const effectiveFontSize = fontSize * (labels[i].tier === 2 ? journeyTaskScale : 1);
        const px = rt.pos[idx * 3];
        const py = rt.pos[idx * 3 + 1] + labels[i].offsetY;
        const pz = rt.pos[idx * 3 + 2];
        const cdist = distTo(px, py, pz);
        proj.set(px, py, pz);
        proj.project(cam);
        if (proj.z > 1 || proj.z < -1) { col[i] += (0 - col[i]) * 0.5; continue; }
        const hw = (text.length * effectiveFontSize * 0.27) / (cdist * tanF * cam.aspect);
        const hh = (effectiveFontSize * 0.78) / (cdist * tanF);
        const x0 = proj.x;
        // search free space alternating UP then DOWN from the node, nearest first,
        // so labels distribute above AND below the row (a packed notebook, not one
        // tall pile) - the key to keeping the dense journey roadmap legible
        const step = hh * 1.3;
        const maxSteps = Math.floor(MAX_PUSH_NDC / step) + 1;
        let y: number | null = overlaps(x0, proj.y, hw, hh) ? null : proj.y;
        for (let s = 1; s <= maxSteps && y === null; s++) {
          if (!overlaps(x0, proj.y + s * step, hw, hh)) y = proj.y + s * step;
          else if (!overlaps(x0, proj.y - s * step, hw, hh)) y = proj.y - s * step;
        }
        if (y === null) {
          if (agentTasks.has(idx)) {
            y = proj.y; // agent-orbited task: never hide - pin its label at the node
          } else {
            col[i] += (0 - col[i]) * 0.5; // truly no room - hide (rare)
            continue;
          }
        }
        kept.push({ x: x0, y, hw, hh });
        // map the NDC-y displacement back to a world-Y push (billboarded)
        pt[i] = (y - proj.y) * (cdist * tanF);
        col[i] += (1 - col[i]) * 0.5;
      }
    }

    const ease = 1 - Math.exp(-7 * delta);
    const lpos = leaderGeo.getAttribute("position") as THREE.BufferAttribute;
    const lcol = leaderGeo.getAttribute("color") as THREE.BufferAttribute;
    const tlpos = taskLeaderGeo.getAttribute("position") as THREE.BufferAttribute;

    for (let i = 0; i < labels.length; i++) {
      const { idx, tier, offsetY, fontSize, accent } = labels[i];
      const px = rt.pos[idx * 3];
      const py = rt.pos[idx * 3 + 1];
      const pz = rt.pos[idx * 3 + 2];
      const ref = refs.current[i];

      if (tier === 1) {
        outward.set(px, py);
        const len = outward.length() || 1;
        const ox = outward.x / len;
        const oy = outward.y / len;
        const lx = px + ox * CLUSTER_LABEL_OUT;
        const ly = py + oy * CLUSTER_LABEL_OUT;

        const focused = focusArea === idx;
        const anyFocus = focusArea >= 0;
        const firing = THREE.MathUtils.clamp((rt.activity[idx] - rt.ambient[idx] * 1.1) * 1.6, 0, 1);
        let op = focused ? 1 : anyFocus ? 0.28 : 0.93 + firing * 0.07;
        op *= 1 - jm;

        if (ref) {
          ref.visible = op > 0.02;
          ref.fillOpacity = op;
          ref.outlineOpacity = op * 0.9;
          // shift AWAY from the medallion on its own side - the old +offsetY*0.2
          // pushed below-side labels back UP into the ring (the overlap bug)
          ref.position.set(lx, ly + (oy >= 0 ? 0.3 : -0.3), pz);
          ref.quaternion.copy(q);
        }
        // live stats sub-line - REAL numbers (graph tasks + store state), ~1Hz
        const stat = statRefs.current[i];
        if (stat) {
          if (frameNo.current % 60 === 0 || !statText.current[i]) {
            const areaId = rt.nodes[idx]?.id;
            if (areaId) {
              const g2 = buildGraph();
              // How much of this initiative is ON THE MAP. It counts authored
              // milestones plus their artifact leaves, so it is a constant per area
              // set by how much was typed into two literal arrays - it does not
              // move when work happens. Reading "27 NODES" directly under an
              // initiative's name made it look like a measure of the initiative;
              // "ON THE MAP" says what the number is actually counting.
              const nodeCount = g2.nodes.filter((n) => n.areaId === areaId && n.tier >= 2).length;
              const txt = `${nodeCount} ON THE MAP`;
              if (txt !== statText.current[i]) {
                statText.current[i] = txt;
                const tt = stat as unknown as { text: string; sync?: () => void };
                tt.text = txt;
                tt.sync?.();
              }
            }
          }
          stat.visible = op > 0.02;
          stat.fillOpacity = op * 0.9;
          stat.outlineOpacity = op * 0.7;
          stat.position.set(lx, ly + (oy >= 0 ? 0.3 : -0.3) - 0.26, pz);
          stat.quaternion.copy(q);
        }
        const lk = clusterLabelIdx.indexOf(i);
        if (lk >= 0) {
          const v = lk * 2;
          // Keep the floating label; collapse the connector to a zero-length black segment so it
          // renders nothing (additive blend + zero length = invisible).
          lpos.setXYZ(v, px, py, pz);
          lpos.setXYZ(v + 1, px, py, pz);
          lcol.setXYZ(v, 0, 0, 0);
          lcol.setXYZ(v + 1, 0, 0, 0);
        }
        // no task-leader for clusters
        tlpos.setXYZ(i * 2, px, py, pz);
        tlpos.setXYZ(i * 2 + 1, px, py, pz);
        continue;
      }

      // tasks / details - eased displacement + visibility
      let op = baseOp(i);
      if (!runCollision) col[i] += (Math.round(col[i]) - col[i]) * ease;
      pc[i] += (pt[i] - pc[i]) * ease;
      op *= THREE.MathUtils.clamp(col[i], 0, 1);

      const ly = py + offsetY + pc[i];
      if (ref) {
        ref.visible = op > 0.02;
        ref.fillOpacity = op;
        ref.outlineOpacity = op * 0.9;
        ref.position.set(px, ly, pz);
        ref.quaternion.copy(q);
        ref.scale.setScalar(tier === 2 ? journeyTaskScale : 1);
      }
      // leader from node-top to a displaced label (up OR down; only when pushed + visible)
      const displaced = Math.abs(pc[i]) > offsetY * 0.4;
      if (displaced && op > 0.05) {
        tlpos.setXYZ(i * 2, px, py + offsetY * 0.5, pz);
        tlpos.setXYZ(i * 2 + 1, px, ly - fontSize * 0.2, pz);
      } else {
        tlpos.setXYZ(i * 2, px, py, pz);
        tlpos.setXYZ(i * 2 + 1, px, py, pz);
      }
      const plan = planRefs.current[i];
      if (plan) {
        // journey-only (opacity rides jm). The status/eta tag sits in the clean
        // band just BELOW the milestone node - clear of the bright lane spine
        // (at the node) and above the artifact comb (DETAIL_TOP below) - so it
        // never lands on the spine the way the old below-the-label spot did.
        const pop = op * jm;
        plan.visible = pop > 0.03;
        plan.fillOpacity = pop * 0.95;
        plan.outlineOpacity = pop * 0.85;
        plan.position.set(px, py - 0.78, pz);
        plan.quaternion.copy(q);
        plan.scale.setScalar(journeyTaskScale);
      }
    }
    lpos.needsUpdate = true;
    lcol.needsUpdate = true;
    tlpos.needsUpdate = true;
  });

  return (
    <group>
      <lineSegments geometry={leaderGeo} material={leaderMat} frustumCulled={false} renderOrder={19} />
      <lineSegments geometry={taskLeaderGeo} material={taskLeaderMat} frustumCulled={false} renderOrder={19} />
      {/* drei <Text> SUSPENDS while its font preloads - a live font swap from the
          Controls picker re-suspends every label. Without this boundary that
          suspension escapes to the root during a synchronous click update and
          React 18 hard-fails the whole window (the other half of the 07-10 wedge).
          Fallback null = labels blink for the load beat, brain never blinks. */}
      <Suspense fallback={null}>
      {labels.map((l, i) => (
        <group key={l.idx}>
          <Text
            ref={(r) => (refs.current[i] = r as unknown as TroikaText)}
            font={l.tier === 1 ? clusterFont.url : LABEL_FONT}
            position={[rt.pos[l.idx * 3], rt.pos[l.idx * 3 + 1] + l.offsetY, rt.pos[l.idx * 3 + 2]]}
            fontSize={l.fontSize}
            color={colors.palette.text}
            anchorX="center"
            anchorY="bottom"
            outlineWidth={l.fontSize * 0.04}
            outlineColor={colors.palette.bgDeep}
            outlineOpacity={0.9}
            material-toneMapped={false}
            material-depthTest={false}
            material-transparent
            renderOrder={20}
            letterSpacing={l.tier === 1 ? 0.09 : 0}
          >
            {l.text}
          </Text>
          {l.tier === 1 && (
            <Text
              ref={(r) => (statRefs.current[i] = r as unknown as TroikaText)}
              font={CLUSTER_STAT_FONT}
              position={[rt.pos[l.idx * 3], rt.pos[l.idx * 3 + 1], rt.pos[l.idx * 3 + 2]]}
              fontSize={0.46}
              color={l.accent.clone().lerp(new THREE.Color("#ffffff"), 0.42)}
              anchorX="center"
              anchorY="top"
              outlineWidth={0.018}
              outlineColor={colors.palette.bgDeep}
              material-toneMapped={false}
              material-depthTest={false}
              material-transparent
              renderOrder={20}
              letterSpacing={0.12}
            >
              {" "}
            </Text>
          )}
          {l.plan && (
            <Text
              ref={(r) => (planRefs.current[i] = r as unknown as TroikaText)}
              font={LABEL_FONT}
              position={[rt.pos[l.idx * 3], rt.pos[l.idx * 3 + 1] - 0.9, rt.pos[l.idx * 3 + 2]]}
              fontSize={0.46}
              color={
                l.planActive
                  ? colors.palette.accent
                  : l.planDone
                    ? colors.palette.baseCool
                    : colors.palette.textDim
              }
              anchorX="center"
              anchorY="top"
              outlineWidth={0.02}
              outlineColor={colors.palette.bgDeep}
              material-toneMapped={false}
              material-depthTest={false}
              material-transparent
              renderOrder={20}
              letterSpacing={0.08}
            >
              {l.plan.toUpperCase()}
            </Text>
          )}
        </group>
      ))}
      </Suspense>
    </group>
  );
}
