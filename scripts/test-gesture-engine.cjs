/**
 * test-gesture-engine - headless logic test for the PURE GestureEngine.
 *
 * A webcam can't run headless, so the *feel* needs the owner's hands - but the state
 * machine (pose classification, pan gating, pull-back→escape, twist→toggle,
 * pinch→dolly) is pure math and IS testable. We transpile the TS engine on the
 * fly with esbuild (no extra dep; vite already bundles it) and feed it synthetic
 * 21-landmark frames, asserting the right high-level action fires.
 *
 * Run: node scripts/test-gesture-engine.cjs
 */
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

// ── load the engine (single self-contained TS file, no imports to resolve) ──
const src = fs.readFileSync(path.join(__dirname, "../src/gesture/gestureEngine.ts"), "utf8");
const { code } = esbuild.transformSync(src, { loader: "ts", format: "cjs", target: "es2020" });
const mod = { exports: {} };
new Function("module", "exports", code)(mod, mod.exports);
const { GestureEngine } = mod.exports;

// ── synthetic hand ──────────────────────────────────────────────────────────
// Canonical 21-landmark templates (hand pointing up, wrist at origin). We then
// scale / rotate / translate into normalized [0..1] image space.
const OPEN = [
  [0, 0], // 0 wrist
  [0.1, -0.05], [0.18, -0.12], [0.24, -0.18], [0.3, -0.24], // thumb 1-4
  [-0.15, -0.4], [-0.16, -0.6], [-0.17, -0.75], [-0.18, -0.9], // index 5-8
  [0, -0.45], [0, -0.66], [0, -0.82], [0, -0.98], // middle 9-12
  [0.15, -0.42], [0.16, -0.62], [0.17, -0.77], [0.18, -0.9], // ring 13-16
  [0.3, -0.35], [0.31, -0.52], [0.32, -0.64], [0.33, -0.74], // pinky 17-20
];
// FIST - fingertips/PIPs curled back toward the palm (close to the wrist).
const FIST = [
  [0, 0],
  [0.1, -0.05], [0.16, -0.1], [0.18, -0.16], [0.16, -0.22], // thumb folded in
  [-0.15, -0.4], [-0.14, -0.32], [-0.12, -0.26], [-0.1, -0.22], // index curled
  [0, -0.45], [0.0, -0.34], [0.0, -0.27], [0.0, -0.23], // middle curled
  [0.15, -0.42], [0.14, -0.33], [0.12, -0.27], [0.1, -0.23], // ring curled
  [0.3, -0.35], [0.27, -0.3], [0.24, -0.26], [0.22, -0.23], // pinky curled
];
// PINCH - middle/ring/pinky extended, index bent so its tip meets the thumb tip.
const PINCH = [
  [0, 0],
  [0.1, -0.05], [0.18, -0.12], [0.24, -0.18], [0.3, -0.24], // thumb 1-4
  [-0.15, -0.4], [-0.05, -0.4], [0.12, -0.32], [0.29, -0.25], // index curls to thumb tip(0.3,-0.24)
  [0, -0.45], [0, -0.66], [0, -0.82], [0, -0.98], // middle extended
  [0.15, -0.42], [0.16, -0.62], [0.17, -0.77], [0.18, -0.9], // ring extended
  [0.3, -0.35], [0.31, -0.52], [0.32, -0.64], [0.33, -0.74], // pinky extended
];

// aimZ pushes the FINGERTIPS forward (toward the camera, -z) → simulates pointing
// the fingers INTO the lens (the drill-in gesture).
const TIPS = new Set([8, 12, 16, 20]);
function makeHand(template, { cx = 0.5, cy = 0.65, scale = 0.44, roll = 0, aimZ = 0 } = {}) {
  const c = Math.cos(roll),
    s = Math.sin(roll);
  return template.map(([x, y], i) => ({
    x: cx + scale * (x * c - y * s),
    y: cy + scale * (x * s + y * c),
    z: TIPS.has(i) ? -aimZ : 0,
  }));
}

// ── tiny assert harness ──────────────────────────────────────────────────────
let pass = 0,
  fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    fail++;
    console.log("  ✗ " + msg);
  }
};

// drive N frames at 33ms each; collect the per-frame results
function drive(engine, frames, t0 = 1000) {
  const out = [];
  let t = t0;
  for (const lm of frames) {
    out.push(engine.update(lm, t));
    t += 33;
  }
  return out;
}

// 1) open hand → idle, no action, no pan
(() => {
  console.log("open hand → idle");
  const e = new GestureEngine();
  const res = drive(e, Array.from({ length: 6 }, () => makeHand(OPEN, { cx: 0.5 })));
  const last = res[res.length - 1];
  ok(last.pose === "open", `classified open (got ${last.pose})`);
  ok(res.every((r) => r.action === "none"), "never fires a discrete action");
  ok(res.every((r) => r.panX === 0 && r.panY === 0), "no pan while open");
})();

// 2) fist + move → pan engages (and is zero while still)
(() => {
  console.log("fist + move → pan");
  const e = new GestureEngine();
  const still = drive(
    e,
    Array.from({ length: 4 }, () => makeHand(FIST, { cx: 0.5 })),
  );
  ok(still[still.length - 1].pose === "fist", `classified fist (got ${still[still.length - 1].pose})`);
  ok(still.slice(2).every((r) => Math.abs(r.panX) < 0.05), "near-zero pan when fist held still");
  // now sweep the hand sideways
  const moved = drive(
    e,
    [0.52, 0.56, 0.6, 0.64].map((cx) => makeHand(FIST, { cx })),
    2000,
  );
  ok(moved.some((r) => Math.abs(r.panX) > 0.2), "pan engages when the fist moves");
})();

// 3) fist + pull back (hand shrinks) → drill OUT
(() => {
  console.log("fist + pull back → drill out");
  const e = new GestureEngine();
  const frames = [];
  // hold a close fist to arm the grab, then pull it toward the shoulder over ~2/3s
  // (a real pull is a sustained shrink, not a single-frame jump - give the
  // One-Euro filter the frames it would actually get).
  for (let i = 0; i < 4; i++) frames.push(makeHand(FIST, { scale: 0.46 }));
  for (let k = 1; k <= 12; k++) frames.push(makeHand(FIST, { scale: 0.46 - (k / 12) * 0.32 }));
  for (let i = 0; i < 4; i++) frames.push(makeHand(FIST, { scale: 0.14 })); // settle small
  const res = drive(e, frames);
  ok(res.some((r) => r.action === "drillOut"), "drillOut fires on pull-back");
  ok(!res.some((r) => r.action === "drillIn"), "a pull-back does not mis-fire a drill-in");
})();

// 4) fist held UP + wrist twist ~180° → flip view; a sideways fist must NOT (misfire fix)
(() => {
  console.log("fist up + twist → flip view");
  const e = new GestureEngine();
  const up = [];
  for (let i = 0; i < 3; i++) up.push(makeHand(FIST, { roll: 0 })); // arm - hand pointing UP
  for (let k = 1; k <= 12; k++) up.push(makeHand(FIST, { roll: (k / 12) * 2.9 })); // rotate ~166°
  const res = drive(e, up);
  ok(res.some((r) => r.action === "toggleView"), "toggleView fires on a near-180° twist when held up");
  ok(!res.some((r) => r.action === "drillIn" || r.action === "drillOut"), "twist does not mis-fire a drill");

  // a SIDEWAYS fist (hand not up → grabUp false) rotating must NOT flip - the owner's misfire fix
  const e2 = new GestureEngine();
  const side = [];
  for (let i = 0; i < 3; i++) side.push(makeHand(FIST, { roll: 1.571 })); // hand points sideways (up≈0)
  for (let k = 1; k <= 12; k++) side.push(makeHand(FIST, { roll: 1.571 + (k / 12) * 2.9 }));
  ok(!drive(e2, side).some((r) => r.action === "toggleView"), "a sideways (not-up) fist twist does NOT flip");
})();

// 5) pinch + vertical → dolly
(() => {
  console.log("pinch + up/down → dolly");
  const e = new GestureEngine();
  const settle = drive(e, Array.from({ length: 3 }, () => makeHand(PINCH, { cy: 0.65 })));
  ok(settle[settle.length - 1].pose === "pinch", `classified pinch (got ${settle[settle.length - 1].pose})`);
  const moved = drive(
    e,
    [0.6, 0.55, 0.5, 0.45].map((cy) => makeHand(PINCH, { cy })),
    3000,
  );
  ok(moved.some((r) => Math.abs(r.dolly) > 0.2), "dolly engages on vertical pinch move");
})();

// 6) no hand → clean idle
(() => {
  console.log("no hand → idle");
  const e = new GestureEngine();
  const r = e.update(null, 1000);
  ok(r.pose === "none" && r.action === "none" && r.panX === 0, "null landmarks → safe idle");
})();

// 7) POINT fingers INTO the camera (fingertips forward in z) → drill IN
(() => {
  console.log("point fingers into the camera → drill in");
  const e = new GestureEngine();
  const frames = [];
  for (let i = 0; i < 4; i++) frames.push(makeHand(OPEN, { aimZ: 0 })); // hand not pointing in
  for (let i = 0; i < 10; i++) frames.push(makeHand(OPEN, { aimZ: 0.6 })); // fingertips forward → pointing INTO lens
  const res = drive(e, frames);
  ok(res.some((r) => r.action === "drillIn"), "drillIn fires when the fingers point into the camera");
  ok(res.filter((r) => r.action === "drillIn").length === 1, "drillIn fires once (hysteresis), no chatter");

  // a hand NOT pointing into the camera never drills
  const e2 = new GestureEngine();
  const steady = drive(e2, Array.from({ length: 16 }, () => makeHand(OPEN, { aimZ: 0 })));
  ok(!steady.some((r) => r.action === "drillIn"), "a hand not pointing in never drills (no false fire)");
})();

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
