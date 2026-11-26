/**
 * handRender - the premium holographic hand overlay (canvas 2D, additive glow).
 *
 * This is the *look*: a softly glowing skeletal hand drawn in an electric
 * blue→violet spectrum, hot white fingertips that throw short light-rays, a
 * roll-reactive palm reticle that fills with live progress as you arm a twist or
 * pull-back, faint motion trails, and a burst flash when a discrete gesture
 * fires. On-brand and intentional - inspired by neon hand-tracking demos, but
 * its own thing (spectrum, reticle, progress arcs, ray-cast tips).
 *
 * Stateful only for the trail + the transient action flash; everything else is a
 * pure function of the current landmarks + GestureFrame.
 */

import type { GestureFrame, Pt } from "./gestureEngine";

// MediaPipe hand skeleton, tagged by finger so each gets its own hue.
type Finger = 0 | 1 | 2 | 3 | 4 | 5; // 0 palm/thumb-base · 1 thumb · 2 index · 3 mid · 4 ring · 5 pinky
const BONES: [number, number, Finger][] = [
  [0, 1, 1], [1, 2, 1], [2, 3, 1], [3, 4, 1],
  [0, 5, 2], [5, 6, 2], [6, 7, 2], [7, 8, 2],
  [5, 9, 3], [9, 10, 3], [10, 11, 3], [11, 12, 3],
  [9, 13, 4], [13, 14, 4], [14, 15, 4], [15, 16, 4],
  [13, 17, 5], [17, 18, 5], [18, 19, 5], [19, 20, 5],
  [0, 17, 0],
];
const TIPS = [4, 8, 12, 16, 20];

// cool (idle/open) spectrum + warm (grab) + violet (pinch), one hue per finger
const COOL: Record<Finger, number> = { 0: 192, 1: 188, 2: 200, 3: 214, 4: 240, 5: 276 };
const WARM: Record<Finger, number> = { 0: 36, 1: 28, 2: 18, 3: 330, 4: 300, 5: 280 };
const VIOLET: Record<Finger, number> = { 0: 268, 1: 262, 2: 272, 3: 282, 4: 292, 5: 300 };

function hueSet(pose: GestureFrame["pose"]): Record<Finger, number> {
  if (pose === "fist") return WARM;
  if (pose === "pinch") return VIOLET;
  return COOL;
}

/** Accent (h,s,l) for the reticle / flashes, keyed off pose. */
function accentHsl(pose: GestureFrame["pose"]): [number, number, number] {
  if (pose === "fist") return [22, 100, 62];
  if (pose === "pinch") return [276, 100, 70];
  return [190, 100, 64];
}

interface Flash {
  kind: "toggleView" | "drillIn" | "drillOut";
  start: number;
}

export class HandRenderer {
  private trail: { x: number; y: number }[] = [];
  private flash: Flash | null = null;
  private lastTip: { x: number; y: number } | null = null;

  reset() {
    this.trail = [];
    this.flash = null;
    this.lastTip = null;
  }

  draw(
    ctx: CanvasRenderingContext2D,
    lm: Pt[] | null,
    w: number,
    h: number,
    frame: GestureFrame,
    tMs: number,
  ): void {
    ctx.clearRect(0, 0, w, h);

    if (frame.action !== "none") {
      this.flash = { kind: frame.action, start: tMs };
    }

    // project mirrored (selfie) screen coords
    const X = (n: Pt) => (1 - n.x) * w;
    const Y = (n: Pt) => n.y * h;
    const px = (frame.signals.cx ?? 0.5) * w;
    const py = (frame.signals.cy ?? 0.5) * h;
    const [ah, as, al] = accentHsl(frame.pose);

    if (lm && lm.length >= 21) {
      // ── soft halo behind the palm ──
      const halo = ctx.createRadialGradient(px, py, 0, px, py, 120);
      halo.addColorStop(0, `hsla(${ah}, ${as}%, ${al}%, 0.18)`);
      halo.addColorStop(1, `hsla(${ah}, ${as}%, ${al}%, 0)`);
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);

      const hues = hueSet(frame.pose);

      // ── motion trail (faint centroid streak) ──
      this.trail.push({ x: px, y: py });
      if (this.trail.length > 14) this.trail.shift();
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 1; i < this.trail.length; i++) {
        const a = (i / this.trail.length) * 0.22;
        ctx.strokeStyle = `hsla(${ah}, ${as}%, ${al}%, ${a})`;
        ctx.lineWidth = (i / this.trail.length) * 5;
        ctx.beginPath();
        ctx.moveTo(this.trail[i - 1].x, this.trail[i - 1].y);
        ctx.lineTo(this.trail[i].x, this.trail[i].y);
        ctx.stroke();
      }
      ctx.restore();

      // ── bones: additive, glowing, per-finger gradient ──
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.lineCap = "round";
      for (const [a, b, finger] of BONES) {
        const ax = X(lm[a]),
          ay = Y(lm[a]),
          bx = X(lm[b]),
          by = Y(lm[b]);
        const hue = hues[finger];
        const grad = ctx.createLinearGradient(ax, ay, bx, by);
        grad.addColorStop(0, `hsla(${hue}, 95%, 66%, 0.95)`);
        grad.addColorStop(1, `hsla(${hue + 18}, 95%, 72%, 0.95)`);
        ctx.strokeStyle = grad;
        ctx.shadowColor = `hsla(${hue}, 100%, 62%, 0.9)`;
        ctx.shadowBlur = 14;
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }

      // ── joints + hot fingertips ──
      ctx.shadowBlur = 10;
      for (let i = 0; i < lm.length; i++) {
        const isTip = TIPS.includes(i);
        const jx = X(lm[i]),
          jy = Y(lm[i]);
        ctx.shadowColor = `hsla(${ah}, 100%, 70%, 0.9)`;
        ctx.fillStyle = isTip ? "rgba(235,246,255,0.98)" : `hsla(${ah}, 90%, 72%, 0.85)`;
        ctx.beginPath();
        ctx.arc(jx, jy, isTip ? 4.4 : 2.6, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── fingertip light-rays (short cast beams away from the palm) ──
      const rayLen = Math.min(w, h) * 0.16;
      for (const tip of TIPS) {
        const prev = tip - 1; // the joint just below the tip → ray direction
        const dx = X(lm[tip]) - X(lm[prev]);
        const dy = Y(lm[tip]) - Y(lm[prev]);
        const len = Math.hypot(dx, dy) || 1;
        const ex = X(lm[tip]) + (dx / len) * rayLen;
        const ey = Y(lm[tip]) + (dy / len) * rayLen;
        const ray = ctx.createLinearGradient(X(lm[tip]), Y(lm[tip]), ex, ey);
        ray.addColorStop(0, "rgba(235,246,255,0.5)");
        ray.addColorStop(1, "rgba(235,246,255,0)");
        ctx.strokeStyle = ray;
        ctx.shadowBlur = 6;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(X(lm[tip]), Y(lm[tip]));
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }
      ctx.restore();

      // ── palm reticle: rotating ring + crosshair, with live progress arcs ──
      this.drawReticle(ctx, px, py, frame, tMs, [ah, as, al]);
    }

    // ── transient action flash ──
    this.drawFlash(ctx, px, py, w, h, tMs);

    // ── live readout: pose + finger splay - lets you SEE the drill signal respond
    // (spread your fingers and watch "splay" climb; a deliberate change drills) ──
    if (lm && lm.length >= 21) {
      ctx.save();
      ctx.globalCompositeOperation = "source-over";
      ctx.font = "600 12px ui-monospace, SFMono-Regular, monospace";
      ctx.fillStyle = "rgba(207,220,246,0.82)";
      ctx.textBaseline = "bottom";
      ctx.fillText(`${frame.pose}   splay ${frame.signals.spread.toFixed(2)}`, 12, h - 11);
      ctx.restore();
    }
  }

  private drawReticle(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    frame: GestureFrame,
    tMs: number,
    [ah, as, al]: [number, number, number],
  ) {
    const r = 26 + frame.signals.scale * 60;
    ctx.save();
    ctx.translate(px, py);
    ctx.globalCompositeOperation = "lighter";

    // base dashed ring, slowly rotating; spins with the hand roll
    ctx.rotate(frame.signals.roll + tMs * 0.0004);
    ctx.strokeStyle = `hsla(${ah}, ${as}%, ${al}%, 0.55)`;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.rotate(-(frame.signals.roll + tMs * 0.0004));

    // crosshair ticks
    ctx.strokeStyle = `hsla(${ah}, ${as}%, ${al}%, 0.8)`;
    ctx.lineWidth = 1.4;
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * (r - 6), Math.sin(a) * (r - 6));
      ctx.lineTo(Math.cos(a) * (r + 6), Math.sin(a) * (r + 6));
      ctx.stroke();
    }

    // FIST armed → twist progress (outer violet, fills as you rotate toward the flip)
    // + pull-back progress (inner white, fills as you pull back to DRILL OUT)
    if (frame.signals.armed && frame.pose === "fist") {
      if (frame.signals.armTwist > 0.02) {
        ctx.strokeStyle = `hsla(276,100%,74%,${0.5 + frame.signals.armTwist * 0.5})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, r + 5, -Math.PI / 2, -Math.PI / 2 + frame.signals.armTwist * Math.PI * 2);
        ctx.stroke();
      }
      if (frame.signals.armPull > 0.02) {
        ctx.strokeStyle = `rgba(235,246,255,${0.5 + frame.signals.armPull * 0.5})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, r - 6, -Math.PI / 2, -Math.PI / 2 + frame.signals.armPull * Math.PI * 2);
        ctx.stroke();
      }
    }
    // POINTING fingers into the camera → drill-in progress (warm arc fills as you aim in)
    if ((frame.pose === "open" || frame.pose === "point") && frame.signals.armPush > 0.02) {
      ctx.strokeStyle = `hsla(28,100%,66%,${0.5 + frame.signals.armPush * 0.5})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, r + 4, -Math.PI / 2, -Math.PI / 2 + frame.signals.armPush * Math.PI * 2);
      ctx.stroke();
    }

    // hot center dot
    ctx.shadowColor = `hsla(${ah}, 100%, 70%, 0.9)`;
    ctx.shadowBlur = 12;
    ctx.fillStyle = "rgba(235,246,255,0.95)";
    ctx.beginPath();
    ctx.arc(0, 0, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawFlash(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    w: number,
    h: number,
    tMs: number,
  ) {
    if (!this.flash) return;
    const dur = 520;
    const u = (tMs - this.flash.start) / dur;
    if (u >= 1) {
      this.flash = null;
      return;
    }
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    if (this.flash.kind === "drillOut") {
      // expanding shockwave - "backing out" pop-out feel
      const rr = u * Math.hypot(w, h) * 0.42;
      ctx.strokeStyle = `rgba(190,214,255,${(1 - u) * 0.8})`;
      ctx.lineWidth = 4 * (1 - u) + 1;
      ctx.beginPath();
      ctx.arc(px, py, rr, 0, Math.PI * 2);
      ctx.stroke();
    } else if (this.flash.kind === "drillIn") {
      // contracting ring → "diving into the task"
      const rr = (1 - u) * Math.min(w, h) * 0.4 + 6;
      ctx.strokeStyle = `hsla(190,100%,72%,${(1 - u) * 0.85})`;
      ctx.lineWidth = 4 * (1 - u) + 1.5;
      ctx.beginPath();
      ctx.arc(px, py, rr, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      // toggleView - rotating violet sweep (view-flip feel)
      const grad = ctx.createConicGradient ? ctx.createConicGradient(u * Math.PI * 4, px, py) : null;
      if (grad) {
        grad.addColorStop(0, `hsla(276,100%,72%,${(1 - u) * 0.6})`);
        grad.addColorStop(0.25, "hsla(276,100%,72%,0)");
        grad.addColorStop(1, "hsla(276,100%,72%,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(px, py, Math.min(w, h) * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}
