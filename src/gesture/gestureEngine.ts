/**
 * gestureEngine - the PURE brain of gesture navigation (no React, no canvas, no
 * camera; just math). Feed it hand landmarks each frame and it returns a smooth,
 * de-jittered control frame: a continuous PAN / DOLLY plus discrete one-shot
 * ACTIONS, with a human-readable label for the HUD.
 *
 * See scripts/test-gesture-engine.cjs.
 *
 * THE VOCABULARY (with the owner; drill = point-into-camera, twist restored 2026-06-21):
 *   ✊ FIST + move ............... grab-drag the canvas - Praxis follows your hand.
 *   👉 POINT fingers INTO the camera .. DRILL IN - point your fingers at the lens (palm to
 *                                 the floor) → dive INTO the cluster/task you're pointing at.
 *                                 It's the ORIENTATION (fingertips sit forward in z), NOT a
 *                                 push; useHandGesture targets the cluster your hand is over.
 *   ✊ FIST + pull straight back .. DRILL OUT - back out: task → its lane → overview.
 *   ✊ FIST held UP + wrist twist ~180° .. FLIP - journey-tree ⇄ main brain. Gated to the
 *                                 hand-up grab + a near-full turn so normal rotation can't
 *                                 misfire it (the version on another plane is what the owner hated).
 *   🤏 PINCH + move up/down ....... DOLLY - fine zoom in (up) / out (down).
 *
 * Everything is smoothed with the One-Euro filter (Casiez et al.) - the standard
 * for low-latency, low-jitter interactive pointer signals. Tunables live in one
 * block so the feel can be dialed in fast from a live session.
 */

export interface Pt {
  x: number;
  y: number;
  z: number;
}

export type Pose = "none" | "open" | "fist" | "pinch" | "point";
export type GestureAction = "none" | "toggleView" | "drillIn" | "drillOut";

/** One processed frame of gesture control - the engine's whole output. */
export interface GestureFrame {
  pose: Pose;
  /** Continuous pan in world units this frame (already gain-scaled). */
  panX: number;
  panY: number;
  /** Continuous dolly in world units this frame (+ in / − out). */
  dolly: number;
  /** A one-shot discrete action that fired THIS frame (else "none"). */
  action: GestureAction;
  /** Short label for the on-screen HUD chip. */
  label: string;
  /** Smoothed, normalized signals - handy for the renderer + the debug readout. */
  signals: {
    /** Palm centroid in mirrored SCREEN space (0..1, x right / y down). */
    cx: number;
    cy: number;
    /** Index-fingertip in mirrored SCREEN space (0..1) - the aim point for drill-in. */
    tipX: number;
    tipY: number;
    /** Hand scale (wrist→middle-knuckle), a proxy for distance to camera. */
    scale: number;
    /** In-plane roll angle of the hand (radians, unwrapped). */
    roll: number;
    /** Thumb-tip→index-tip distance ÷ scale (pinch tightness; small = pinched). */
    pinch: number;
    /** Mean adjacent-fingertip gap ÷ scale (finger splay; small = together, large = spread). */
    spread: number;
    /** True while a grab is armed (fist held) - the twist/pull watch window. */
    armed: boolean;
    /** 0..1 progress toward the twist-to-flip-view threshold (reticle arc). */
    armTwist: number;
    /** 0..1 progress toward the pull-back-to-DRILL-OUT threshold (reticle arc). */
    armPull: number;
    /** 0..1 progress toward the point-into-camera-to-DRILL-IN threshold (reticle arc). */
    armPush: number;
  };
}

const T = {
  // One-Euro filter - nudged snappier (tracks the hand with less lag)
  euroMinCutoff: 1.5, // raise → less lag, more jitter (was 1.2)
  euroBeta: 0.016, // raise → less lag on fast motion (was 0.012)
  euroDCutoff: 1.0,

  // pan (grab-drag). Praxis follows the hand: hand-left → Praxis-left.
  panGainX: 70, // was 58 - more pan per hand-move
  panGainY: 56, // was 46
  panDeadzone: 0.0011, // was 0.0016 - registers smaller hand moves as pan
  panMaxStep: 3.6, // world-unit clamp per frame (raised with the gain so it isn't the new limiter)
  pullGate: 1.4, // if the hand is shrinking faster than this (scale/sec), suppress pan (it's an escape, not a drag)

  // drill OUT (fist pull back). A held fist pulled toward you - shrinks past this
  // fraction of its grab size - backs OUT. 0.56 (was 0.64): needs a BIGGER deliberate
  // pull so it doesn't fire while you're just moving your hand around (the owner's note).
  escapeRatio: 0.56,
  escapeMinGrab: 0.078, // the grab must be at least this big to arm a pull

  // flip view (fist + wrist twist). Gated to the hand-up pose + a near- full turn so normal hand
  // rotation while panning can't misfire it.
  twistThreshold: 2.7, // radians (~155°) - a deliberate near-180° wrist rotation
  twistHandUp: 0.15, // hand must point UP ((wrist.y − mcp.y) ÷ scale) to arm the twist

  // drill IN (point fingers INTO the camera). Hysteresis: must un-point below aimExit before it
  // can re-fire.
  aimEnter: 0.9, // aim (fingertip-forward ÷ scale) above this → drill into the pointed-at cluster
  aimExit: 0.45, // drop below this to re-arm
  // pointer = the INDEX FINGERTIP position (where you AIM), amplified about frame-centre so
  // a small hand movement covers the whole screen (fixes "always grabs the bottom cluster,
  // can't reach the top / hard side-to-side"). The fingertip rides higher than the palm, so
  // pointing up actually reaches the top clusters.
  pointerGain: 2.0,


  // dolly (pinch) - moderately punchy so a small pinch-drag covers real zoom range
  pinchOn: 0.48, // was 0.42 - a looser pinch now counts (easier to enter pinch)
  pinchOff: 0.66, // hysteresis: release above this (kept ~0.18 above pinchOn)
  dollyGain: 76, // was 64 (itself up from 42) - fewer pinch-drags to cover the zoom range
  dollyDeadzone: 0.001, // was 0.0014 - smaller vertical move starts a zoom
  dollyMaxStep: 3.8, // raised with the gain

  // shared
  cooldownMs: 650, // after a discrete action, lock out re-fire until the hand opens or this elapses
};

// ─────────────────────────── One-Euro filter ───────────────────────────
class LowPass {
  private y: number | null = null;
  filter(x: number, alpha: number): number {
    this.y = this.y == null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  get last(): number | null {
    return this.y;
  }
  reset() {
    this.y = null;
  }
}

class OneEuro {
  private x = new LowPass();
  private dx = new LowPass();
  private lastT: number | null = null;
  constructor(
    private minCutoff = T.euroMinCutoff,
    private beta = T.euroBeta,
    private dCutoff = T.euroDCutoff,
  ) {}
  private alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value: number, tMs: number): number {
    if (this.lastT == null) {
      this.lastT = tMs;
      this.x.filter(value, 1);
      return value;
    }
    const dt = Math.max(1e-3, (tMs - this.lastT) / 1000);
    this.lastT = tMs;
    const dxRaw = (value - (this.x.last ?? value)) / dt;
    const edx = this.dx.filter(dxRaw, this.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, this.alpha(cutoff, dt));
  }
  reset() {
    this.x.reset();
    this.dx.reset();
    this.lastT = null;
  }
}

// ─────────────────────────── landmark helpers ───────────────────────────
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Finger considered extended when its tip is clearly farther from the wrist than its PIP joint. */
function extended(lm: Pt[], tip: number, pip: number): boolean {
  return dist(lm[0], lm[tip]) > dist(lm[0], lm[pip]) * 1.12;
}

function countExtended(lm: Pt[]): number {
  let n = 0;
  if (extended(lm, 8, 6)) n++; // index
  if (extended(lm, 12, 10)) n++; // middle
  if (extended(lm, 16, 14)) n++; // ring
  if (extended(lm, 20, 18)) n++; // pinky
  return n;
}

/** Classify the static hand pose from the smoothed pinch ratio + finger extension. */
function classify(lm: Pt[], pinchRatio: number, prevPinched: boolean): Pose {
  const ext = countExtended(lm);
  const others = (extended(lm, 12, 10) ? 1 : 0) + (extended(lm, 16, 14) ? 1 : 0) + (extended(lm, 20, 18) ? 1 : 0);
  // pinch needs thumb+index touching WHILE the other fingers stay out (so a fist
  // - where everything is curled and the thumb also nears the index - isn't a pinch)
  const pinchThresh = prevPinched ? T.pinchOff : T.pinchOn;
  if (pinchRatio < pinchThresh && others >= 2) return "pinch";
  if (ext <= 1) return "fist";
  if (ext >= 4) return "open";
  if (extended(lm, 8, 6) && others === 0) return "point";
  return "open";
}

/** Palm centroid + scale + roll, in MIRRORED screen space (selfie view). */
function readHand(lm: Pt[]) {
  const palm = [0, 5, 9, 13, 17];
  let sx = 0,
    sy = 0;
  for (const i of palm) {
    sx += 1 - lm[i].x; // mirror x so screen matches the flipped video
    sy += lm[i].y;
  }
  const cx = sx / palm.length;
  const cy = sy / palm.length;
  const scale = dist(lm[0], lm[9]) || 1e-4;
  // roll = angle of the index-MCP → pinky-MCP baseline (rotates as the hand twists)
  const roll = Math.atan2(lm[17].y - lm[5].y, 1 - lm[17].x - (1 - lm[5].x));
  const pinch = dist(lm[4], lm[8]) / scale;
  // finger splay = mean gap between adjacent fingertips (index·middle·ring·pinky),
  // scale-normalized. Small when the tips bunch together, large when fingers fan out.
  const spread = (dist(lm[8], lm[12]) + dist(lm[12], lm[16]) + dist(lm[16], lm[20])) / 3 / scale;
  // aim = how much the fingertips point INTO the screen (toward the camera): they sit
  // forward (smaller MediaPipe z) of the wrist. >0 when pointing in; the drill-in signal.
  const tipZ = (lm[8].z + lm[12].z + lm[16].z + lm[20].z) / 4;
  const aim = (lm[0].z - tipZ) / scale;
  // up = hand pointing UP (middle-knuckle above the wrist) - gates the twist to the
  // deliberate "arm vertical, rotate wrist" pose so it doesn't misfire in other planes.
  const up = (lm[0].y - lm[9].y) / scale;
  const tipx = 1 - lm[8].x;
  const tipy = lm[8].y;
  return { cx, cy, scale, roll, pinch, spread, aim, up, tipx, tipy };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Unwrap `next` to be continuous with `prev` (so a twist past ±π accumulates). */
function unwrap(prev: number, next: number): number {
  let d = next - prev;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return prev + d;
}

export class GestureEngine {
  private fx = new OneEuro();
  private fy = new OneEuro();
  private fscale = new OneEuro();
  private fpinch = new OneEuro();
  private fspread = new OneEuro();
  private faim = new OneEuro(); // smooth the noisy depth-aim signal
  private ftipx = new OneEuro();
  private ftipy = new OneEuro();
  private prev: { cx: number; cy: number; scale: number; roll: number } | null = null;
  private rollAcc = 0; // unwrapped, continuous roll
  // grab state (armed while a fist is held)
  private armed = false;
  private grabScale = 0;
  private grabRoll = 0; // roll when the fist armed - the twist watches the delta from here
  private grabUp = false; // was the hand vertical (pointing up) when the fist armed? (twist gate)
  private cooldownUntil = 0;
  private pinched = false;
  private aimed = false; // hysteresis latch: true while the hand is pointing into the camera

  reset() {
    this.fx.reset();
    this.fy.reset();
    this.fscale.reset();
    this.fpinch.reset();
    this.fspread.reset();
    this.faim.reset();
    this.ftipx.reset();
    this.ftipy.reset();
    this.prev = null;
    this.rollAcc = 0;
    this.armed = false;
    this.pinched = false;
    this.cooldownUntil = 0;
    this.aimed = false;
  }

  private idle(label = ""): GestureFrame {
    return {
      pose: "none",
      panX: 0,
      panY: 0,
      dolly: 0,
      action: "none",
      label,
      signals: { cx: 0.5, cy: 0.5, tipX: 0.5, tipY: 0.5, scale: 0, roll: 0, pinch: 1, spread: 0.4, armed: false, armTwist: 0, armPull: 0, armPush: 0 },
    };
  }

  /** Process one frame. `lm` = 21 hand landmarks (null/empty = no hand). */
  update(lm: Pt[] | null | undefined, tMs: number): GestureFrame {
    if (!lm || lm.length < 21) {
      this.prev = null;
      this.armed = false;
      this.aimed = false;
      return this.idle();
    }

    const raw = readHand(lm);
    const cx = this.fx.filter(raw.cx, tMs);
    const cy = this.fy.filter(raw.cy, tMs);
    const scale = this.fscale.filter(raw.scale, tMs);
    const pinchRatio = this.fpinch.filter(raw.pinch, tMs);
    const spread = this.fspread.filter(raw.spread, tMs);
    const aim = this.faim.filter(raw.aim, tMs); // fingertips-forward → pointing into the camera
    const tipX = this.ftipx.filter(raw.tipx, tMs);
    const tipY = this.ftipy.filter(raw.tipy, tMs);
    // accumulate roll continuously so a 180° twist reads as ~π regardless of wrap
    this.rollAcc = this.prev ? unwrap(this.rollAcc, raw.roll) : raw.roll;
    const roll = this.rollAcc;

    const pose = classify(lm, pinchRatio, this.pinched);
    this.pinched = pose === "pinch";

    // per-frame deltas + scale velocity (units/sec) on the SMOOTHED signals
    let dcx = 0,
      dcy = 0,
      dScaleVel = 0;
    if (this.prev) {
      dcx = cx - this.prev.cx;
      dcy = cy - this.prev.cy;
      const dt = 1 / 60; // velocity scale is approximate; only its sign/magnitude band matters
      dScaleVel = (scale - this.prev.scale) / dt;
    }

    let panX = 0,
      panY = 0,
      dolly = 0;
    let action: GestureAction = "none";
    let label = "";
    let armTwist = 0,
      armPull = 0,
      armPush = 0;

    const inCooldown = tMs < this.cooldownUntil;
    if (pose !== "fist") this.armed = false;

    // DRILL IN - point your fingers INTO the camera (palm to the floor): the fingertips
    // sit forward of the wrist (high `aim`). The ORIENTATION fires it - no push/scale -
    // and useHandGesture dives into the cluster your hand is pointing at. Works whatever
    // the pose classifies as (a fist has low aim, so it can't trigger here). Hysteresis.
    armPush = clamp((aim - T.aimExit) / (T.aimEnter - T.aimExit), 0, 1);
    if (!inCooldown && !this.aimed && aim > T.aimEnter) {
      action = "drillIn";
      label = "👉 pointing in → dive into it";
      this.cooldownUntil = tMs + T.cooldownMs;
      this.aimed = true;
    } else if (aim < T.aimExit) {
      this.aimed = false;
    }

    if (action === "none") {
      if (pose === "fist") {
        // arm the grab on entry (records the size + roll we watch for pull / twist)
        if (!this.armed) {
          this.armed = true;
          this.grabScale = scale;
          this.grabRoll = roll;
          this.grabUp = raw.up > T.twistHandUp; // was the hand vertical when grabbed?
        }
        const dRoll = roll - this.grabRoll;
        const shrinking = dScaleVel < -T.pullGate;
        const grabbed = this.grabScale >= T.escapeMinGrab;
        const yanked = grabbed && scale < this.grabScale * T.escapeRatio;
        // twist only if the hand STARTED vertical (a 180° turn ends inverted, so gating
        // on the live orientation would never fire) + a near-full deliberate rotation
        const twisted = this.grabUp && Math.abs(dRoll) >= T.twistThreshold;
        armTwist = this.grabUp ? clamp(Math.abs(dRoll) / T.twistThreshold, 0, 1) : 0;
        armPull = grabbed ? clamp((1 - scale / this.grabScale) / (1 - T.escapeRatio), 0, 1) : 0;

        if (!inCooldown && twisted) {
          // fist held UP + wrist twist ~180° → flip journey ⇄ brain (the owner's original)
          action = "toggleView";
          label = "✊ twist → flip view";
          this.cooldownUntil = tMs + T.cooldownMs;
          this.armed = false;
        } else if (!inCooldown && yanked) {
          // grab + pull back → BACK OUT (task → lane → overview)
          action = "drillOut";
          label = "✊ pull back → back out";
          this.cooldownUntil = tMs + T.cooldownMs;
          this.armed = false;
        } else {
          label = "✊ grab — move to pan · twist to flip · pull to exit";
          if (this.prev && !shrinking && !inCooldown) {
            // Horizontal follows the hand: hand-left → Praxis-left. Vertical FLIPPED
            // per the owner's live test: hand-down moves Praxis down.
            if (Math.abs(dcx) > T.panDeadzone)
              panX = clamp(-dcx * T.panGainX, -T.panMaxStep, T.panMaxStep);
            if (Math.abs(dcy) > T.panDeadzone)
              panY = clamp(-dcy * T.panGainY, -T.panMaxStep, T.panMaxStep);
          }
        }
      } else if (pose === "pinch") {
        label = "🤏 pinch — up/down to zoom";
        if (this.prev && Math.abs(dcy) > T.dollyDeadzone) {
          // hand up (dcy < 0) → zoom in (+dolly)
          dolly = clamp(-dcy * T.dollyGain, -T.dollyMaxStep, T.dollyMaxStep);
        }
      } else {
        label = pose === "open" || pose === "point" ? "👉 point your fingers into the camera → dive in" : "";
      }
    }

    this.prev = { cx, cy, scale, roll };

    return {
      pose,
      panX,
      panY,
      dolly,
      action,
      label,
      signals: { cx, cy, tipX, tipY, scale, roll, pinch: pinchRatio, spread, armed: this.armed, armTwist, armPull, armPush },
    };
  }
}

/** Exposed for tests + the tuning panel. */
export const GESTURE_TUNABLES = T;
