/**
 * CameraRig - ONE pan/dolly map camera (round3-remodel-lock R2/R3).
 *
 * R2: NO free orbit, ever. The azimuth/polar angles are PINNED (min = max) at
 * the one fixed view direction (VIEW_DIR, ~12° downward tilt), so rotation is
 * impossible by construction. Input is remapped: drag = truck/pan (clamped to
 * the layout bounds), wheel = clamped dolly. That's it.
 *
 * R3: travel is Google-Maps style - selecting an area/node runs a GSAP tween
 * that pans the look-at point laterally while gently dollying to the framing's
 * distance (1.2–1.8s, ease in-out). No 3D arcs, no teleports; reduced-motion
 * snaps instantly.
 *
 * We keep the controls updating and freeze USER INPUT instead (mouseButtons/touches → NONE),
 * thawing on arrival/interrupt.
 */

import { useEffect, useRef } from "react";
import { CameraControls } from "@react-three/drei";
import CameraControlsImpl from "camera-controls";
import * as THREE from "three";
import gsap from "gsap";
import { useRuntime } from "./context";
import { setCameraControls, setCenteredResolver, setNodeAtScreenResolver, setStepOut } from "./cameraApi";
import { usePraxisStore } from "@/store/usePraxisStore";
import { buildGraph } from "@/data/graph";
import {
  AZIMUTH_PIN,
  BOUNDS,
  JOURNEY_FRAMING,
  MAX_DIST,
  MIN_DIST,
  OVERVIEW_FRAMING,
  POLAR_PIN,
  VIEW_DIR,
  clusterFramings,
  journeyLaneFraming,
  journeyTimeFraming,
  type Framing,
} from "./framings";
import { journeyLaneY } from "@/data/journeyLayout";

// viewing distance by tier when focused on a single node (areas use their framing)
const VIEW_DIST: Record<number, number> = { 0: 42, 1: 28, 2: 14, 3: 9.5 };

type Controls = CameraControlsImpl;

/** Forbid rotation by construction: pin the spherical angles (min = max). */
function pinAngles(c: Controls) {
  c.minAzimuthAngle = AZIMUTH_PIN;
  c.maxAzimuthAngle = AZIMUTH_PIN;
  c.minPolarAngle = POLAR_PIN;
  c.maxPolarAngle = POLAR_PIN;
}

/** Free the dolly band so a flight is never fought by stale clamps. */
function widenDistance(c: Controls) {
  c.minDistance = MIN_DIST;
  c.maxDistance = MAX_DIST;
}

/** Re-clamp the dolly band around the arrived framing. */
function applyFramingDistance(c: Controls, f: Framing) {
  c.minDistance = Math.max(MIN_DIST, f.dist * f.distWindow[0]);
  c.maxDistance = Math.min(MAX_DIST, f.dist * f.distWindow[1]);
}

/** Up axis, for the screen-right computation. */
const UP = new THREE.Vector3(0, 1, 0);

/** World-space lateral shift that centres content in the REAL reading surface
 *  between the left tool rail and right inspector. Focused subjects always use
 *  it; Journey also uses it at overview because the roadmap occupies the full
 *  width and was previously hidden beneath the dock. */
function panToSafeArea(
  c: Controls,
  destDist: number,
  p0: THREE.Vector3,
  t0: THREE.Vector3,
  out: THREE.Vector3,
  includeOverview: boolean,
): void {
  out.set(0, 0, 0);
  if (!includeOverview && !usePraxisStore.getState().focusId) return;
  const cam = c.camera as THREE.PerspectiveCamera;
  if (!cam?.isPerspectiveCamera) return;
  const rail = document.querySelector(".rail") as HTMLElement | null;
  const dock = document.querySelector(".dock") as HTMLElement | null;
  const viewportWidth = Math.max(1, window.innerWidth);
  const safeLeft = rail && rail.offsetWidth
    ? rail.getBoundingClientRect().right + 24
    : 24;
  const safeRight = dock && dock.offsetWidth
    ? dock.getBoundingClientRect().left - 24
    : viewportWidth - 24;
  if (safeRight <= safeLeft) return;
  const desiredCenter = (safeLeft + safeRight) * 0.5;
  const pixelOffset = viewportWidth * 0.5 - desiredCenter;
  const halfW = destDist * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * cam.aspect;
  const worldOffset = pixelOffset * ((halfW * 2) / viewportWidth);
  // Shift the camera target screen-right so the composed subject lands leftward
  // in the unobstructed strip. Azimuth is pinned, so this remains horizontal.
  out.subVectors(t0, p0).normalize().cross(UP).normalize().multiplyScalar(worldOffset);
}

/** R2 input map: drag = pan, wheel = dolly. Rotation is unmapped everywhere. */
function applyPanOnlyInput(c: Controls) {
  c.mouseButtons.left = CameraControlsImpl.ACTION.TRUCK;
  c.mouseButtons.middle = CameraControlsImpl.ACTION.DOLLY;
  c.mouseButtons.right = CameraControlsImpl.ACTION.TRUCK;
  c.mouseButtons.wheel = CameraControlsImpl.ACTION.DOLLY;
  c.touches.one = CameraControlsImpl.ACTION.TOUCH_TRUCK;
  c.touches.two = CameraControlsImpl.ACTION.TOUCH_DOLLY_TRUCK;
  c.touches.three = CameraControlsImpl.ACTION.TOUCH_TRUCK;
}

export function CameraRig() {
  const rt = useRuntime();
  const controlsRef = useRef<Controls>(null);
  const tween = useRef<gsap.core.Tween | null>(null);

  const focusNonce = usePraxisStore((s) => s.focusNonce);

  // scratch (no per-flight allocation beyond the tween itself)
  const p0 = useRef(new THREE.Vector3());
  const t0 = useRef(new THREE.Vector3());
  const targetPos = useRef(new THREE.Vector3());

  // initial overview framing (no animation) + hard bounds + pan-only input
  useEffect(() => {
    const c = controlsRef.current;
    if (!c) return;
    const d = VIEW_DIR.clone().multiplyScalar(OVERVIEW_FRAMING.dist);
    c.setLookAt(d.x, d.y, d.z, 0, 0, 0, false);
    c.setBoundary(BOUNDS);
    c.boundaryFriction = 0.12;
    pinAngles(c);
    applyFramingDistance(c, OVERVIEW_FRAMING);
    // set the pan-only map ONCE here, so the flight freeze/thaw below
    // saves/restores the TRUCK/DOLLY set (it restores whatever is configured)
    applyPanOnlyInput(c);
    rt.focusTarget.set(0, 0, 0);
    // expose the rig to the gesture/keyboard nav bridge + the verify harness
    setCameraControls(c);
    (window as unknown as { __praxisCam?: Controls }).__praxisCam = c;

    // drill targets are REAL clusters (tier-1) in brain, milestones + area medallions
    // in journey - never the hub or a stray off-view node (that was the "lands on a
    // random in-between spot" bug). Shared by both resolvers below.
    const drillIds = (): string[] => {
      const { viewMode, journey } = usePraxisStore.getState();
      const g = buildGraph();
      return viewMode === "journey"
        ? [...g.nodes.filter((n) => n.tier === 1).map((n) => n.id), ...journey.map((m) => m.id)]
        : g.nodes.filter((n) => n.tier === 1).map((n) => n.id);
    };
    const arrFor = () =>
      usePraxisStore.getState().viewMode === "journey" ? rt.posJourney : rt.posBrain;

    // "what's centered?" - the node nearest the look-at (rt.focusTarget). Fallback for
    // the drill when the gesture has no pointer.
    setCenteredResolver(() => {
      const arr = arrFor();
      const tgt = rt.focusTarget;
      let best: string | null = null;
      let bestD = Infinity;
      for (const id of drillIds()) {
        const i = rt.index.get(id);
        if (i == null) continue;
        const dx = arr[i * 3] - tgt.x;
        const dy = arr[i * 3 + 1] - tgt.y;
        const dz = arr[i * 3 + 2] - tgt.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
      return best;
    });

    // "what cluster is the hand POINTING at?" - project candidates to screen NDC and
    // return the nearest to the pointer (nx,ny). Powers gesture point-at-cluster.
    const projV = new THREE.Vector3();
    setNodeAtScreenResolver((nx, ny) => {
      const cam = c.camera;
      if (!cam) return null;
      const arr = arrFor();
      let best: string | null = null;
      let bestD = Infinity;
      for (const id of drillIds()) {
        const i = rt.index.get(id);
        if (i == null) continue;
        projV.set(arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]).project(cam);
        if (projV.z > 1) continue; // behind the camera
        const dx = projV.x - nx;
        const dy = projV.y - ny;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
      return best;
    });

    // "step out" of a drilled task IN PLACE: free the dolly band + ease the camera out a
    // little, KEEPING the look-at - so you stay over the same space, just zoomed out and
    // unconstrained (not flown to a new framing). Drives drillOut's first level.
    setStepOut(() => {
      const cc = controlsRef.current;
      if (!cc) return;
      tween.current?.kill();
      widenDistance(cc); // unconstrain
      const d = cc.distance ?? 24;
      cc.dolly(-d * 0.4, true); // negative = out (matches gestureDolly), with a gentle transition
    });

    return () => {
      setCameraControls(null);
      setCenteredResolver(null);
      setNodeAtScreenResolver(null);
      setStepOut(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // travel on every focus() (focusNonce bumps even on repeat selects).
  useEffect(() => {
    const c = controlsRef.current;
    if (!c) return;
    const { focusId, viewMode, journeyView, journey } = usePraxisStore.getState();

    // the dolly band to re-clamp to on arrival - exactly one of these is set
    let navBand: [number, number] | null = null; // [minMul, maxMul] × destDist
    let navFraming: Framing | null = null; // re-clamp to a framing's window
    let destDist: number;

    // a close read band for a single journey node, so you can dolly in to read
    // its artifact comb instead of snapping back out to the roadmap overview
    const nodeReadBand = (d: number): [number, number] => [
      MIN_DIST / d,
      Math.min(MAX_DIST, Math.max(d * 2.4, 30)) / d,
    ];

    if (viewMode === "journey" && journeyView) {
      // ---- JOURNEY NAV - time scrub (←/→) · lane switch (↑/↓) · task hop ----
      if (journeyView.kind === "task") {
        const i = rt.index.get(journeyView.id) ?? -1;
        if (i < 0) return; // milestone beyond the sprout budget - hold position
        targetPos.current.set(rt.posJourney[i * 3], rt.posJourney[i * 3 + 1], rt.posJourney[i * 3 + 2]);
        destDist = VIEW_DIST[rt.tier[i]] ?? 12;
        navBand = nodeReadBand(destDist);
      } else if (journeyView.kind === "areaRow") {
        // ↑/↓ ROW BUMP - glide straight up/down to the adjacent lane, keeping the
        // current look-at X (time position) AND the current dolly distance (zoom).
        // No sideways drift through time, no rezoom - just a vertical truck.
        c.getTarget(t0.current);
        c.getPosition(p0.current);
        const curDist = p0.current.distanceTo(t0.current);
        targetPos.current.set(t0.current.x, journeyLaneY(journeyView.areaId), t0.current.z);
        destDist = curDist;
        navBand = [MIN_DIST / curDist, MAX_DIST / curDist]; // leave the dolly free; don't snap
      } else {
        const f =
          journeyView.kind === "area"
            ? journeyLaneFraming(buildGraph(), journey, journeyView.areaId)
            : journeyTimeFraming(buildGraph(), journey, journeyView.col);
        targetPos.current.copy(f.lookAt);
        destDist = f.dist;
        navFraming = f;
      }
    } else {
      // ---- generic focus path (brain framings · overview · node focus) ------
      const idx = focusId ? rt.index.get(focusId) ?? -1 : -1;
      // a focus id with no 3D node (e.g. a milestone beyond the sprout budget)
      // must NOT yank the camera to the overview - hold position instead
      if (focusId && idx < 0) return;

      // the sector framing that owns this travel (brain mode only).
      // Static nodes resolve via the graph; session sprouts via the journey model.
      const areaId = focusId
        ? (buildGraph().byId.get(focusId)?.areaId ??
          journey.find((m) => m.id === focusId)?.areaId ??
          null)
        : null;
      const framing: Framing =
        viewMode === "journey"
          ? JOURNEY_FRAMING
          : (areaId && clusterFramings().get(areaId)) || OVERVIEW_FRAMING;

      const tier = idx >= 0 ? rt.tier[idx] : -1;
      if (idx >= 0) {
        if (viewMode === "brain" && tier === 1) {
          // areas pan to their COMPOSED sector framing center, not the raw node
          targetPos.current.copy(framing.lookAt);
        } else {
          const arr = viewMode === "journey" ? rt.posJourney : rt.posBrain;
          targetPos.current.set(arr[idx * 3], arr[idx * 3 + 1], arr[idx * 3 + 2]);
        }
      } else {
        targetPos.current.copy(framing.lookAt);
      }
      destDist =
        idx >= 0 ? (viewMode === "brain" && tier === 1 ? framing.dist : VIEW_DIST[tier] ?? 16) : framing.dist;
      if (viewMode === "journey" && idx >= 0) navBand = nodeReadBand(destDist);
      else navFraming = framing;
    }

    // current camera pos + target
    c.getPosition(p0.current);
    c.getTarget(t0.current);
    const d0 = p0.current.distanceTo(t0.current);

    // Centre the destination in the unobstructed reading surface. Journey needs
    // this even at overview because its outer rails span the entire map.
    const lookShift = new THREE.Vector3();
    panToSafeArea(c, destDist, p0.current, t0.current, lookShift, viewMode === "journey");

    tween.current?.kill();

    // the dolly band must not fight the flight - widen now, re-clamp on arrival
    widenDistance(c);
    const arrive = () => {
      // re-clamp the dolly band around wherever we landed. navBand is a close
      // read band (a single node / time slab); navFraming re-applies a framing's
      // own window (brain sector, overview). Exactly one is set per flight.
      if (navBand) {
        c.minDistance = Math.max(MIN_DIST, destDist * navBand[0]);
        c.maxDistance = Math.min(MAX_DIST, destDist * navBand[1]);
      } else if (navFraming) {
        applyFramingDistance(c, navFraming);
      } else {
        widenDistance(c);
      }
    };

    // reduced motion: arrive instantly - same destination, no tween (lock rule)
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const lx = targetPos.current.x + lookShift.x;
      const ly = targetPos.current.y + lookShift.y;
      const lz = targetPos.current.z + lookShift.z;
      c.setLookAt(lx + VIEW_DIR.x * destDist, ly + VIEW_DIR.y * destDist, lz + VIEW_DIR.z * destDist, lx, ly, lz, false);
      rt.focusTarget.set(lx, ly, lz);
      arrive();
      return;
    }

    // THE FIX: keep the controls updating every frame (so setLookAt applies),
    // freeze USER INPUT instead of the whole rig.
    const saved = {
      left: c.mouseButtons.left,
      middle: c.mouseButtons.middle,
      right: c.mouseButtons.right,
      wheel: c.mouseButtons.wheel,
      one: c.touches.one,
      two: c.touches.two,
      three: c.touches.three,
    };
    const freeze = () => {
      c.mouseButtons.left = CameraControlsImpl.ACTION.NONE;
      c.mouseButtons.middle = CameraControlsImpl.ACTION.NONE;
      c.mouseButtons.right = CameraControlsImpl.ACTION.NONE;
      c.mouseButtons.wheel = CameraControlsImpl.ACTION.NONE;
      c.touches.one = CameraControlsImpl.ACTION.NONE;
      c.touches.two = CameraControlsImpl.ACTION.NONE;
      c.touches.three = CameraControlsImpl.ACTION.NONE;
    };
    const thaw = () => {
      c.mouseButtons.left = saved.left;
      c.mouseButtons.middle = saved.middle;
      c.mouseButtons.right = saved.right;
      c.mouseButtons.wheel = saved.wheel;
      c.touches.one = saved.one;
      c.touches.two = saved.two;
      c.touches.three = saved.three;
    };
    freeze();

    const endFlight = () => {
      thaw();
      window.removeEventListener("pointerdown", interrupt);
      window.removeEventListener("wheel", onWheel);
    };
    // trackpad stays co-equal: grabbing mid-flight hands the rig straight back.
    // Wheel interrupts are debounced - trackpad INERTIA from the click-scroll
    // that started the flight must not kill it at u≈0.
    const state = { u: 0 };
    const interrupt = () => {
      tween.current?.kill();
      endFlight();
      widenDistance(c); // the user took over - don't trap them in a band
    };
    const onWheel = (e: WheelEvent) => {
      if (state.u > 0.12 && Math.abs(e.deltaY) > 24) interrupt();
    };
    window.addEventListener("pointerdown", interrupt);
    window.addEventListener("wheel", onWheel, { passive: true });

    // R3 travel: a straight lateral pan of the look-at + a dolly along the ONE
    // fixed view direction. gsap eases u (power3.inOut); pos = look + dir·dist.
    const look = new THREE.Vector3();
    const lookStart = t0.current.clone();
    const lookEnd = targetPos.current.clone().add(lookShift); // arrive offset to clear the dock
    const travel = lookEnd.distanceTo(lookStart) + Math.abs(destDist - d0) * 0.5;
    tween.current = gsap.to(state, {
      u: 1,
      duration: THREE.MathUtils.clamp(0.85 + travel * 0.014, 1.2, 1.8),
      ease: "power3.inOut",
      onUpdate: () => {
        look.lerpVectors(lookStart, lookEnd, state.u);
        const dist = d0 + (destDist - d0) * state.u;
        c.setLookAt(
          look.x + VIEW_DIR.x * dist,
          look.y + VIEW_DIR.y * dist,
          look.z + VIEW_DIR.z * dist,
          look.x,
          look.y,
          look.z,
          false,
        );
        rt.focusTarget.copy(look);
      },
      onComplete: () => {
        endFlight();
        rt.focusTarget.copy(targetPos.current); // the NODE (unshifted) so "centred node" logic stays true
        arrive();
      },
    });

    return () => {
      tween.current?.kill();
      endFlight();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNonce]);

  return (
    <CameraControls
      ref={controlsRef}
      makeDefault
      minDistance={MIN_DIST}
      maxDistance={MAX_DIST}
      dollySpeed={0.6}
      truckSpeed={1.2}
      smoothTime={0.28}
      draggingSmoothTime={0.12}
    />
  );
}
