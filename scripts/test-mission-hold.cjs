/**
 * A mission run owns the agent it dispatched (src/store/usePraxisStore.ts, agent:status).
 * Live 2026-10-01: Forge's mission dispatch was re-anchored to the Praxis node within seconds
 * by the slower session census. The census may not move or idle a mission-held agent.
 *
 * Run: node scripts/test-mission-hold.cjs
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
global.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, location: { pathname: "/" }, localStorage: global.localStorage };
global.CustomEvent = class CustomEvent { constructor(t, i = {}) { this.type = t; this.detail = i.detail; } };
global.document = { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };

const result = esbuild.buildSync({
  entryPoints: [path.join(root, "src/store/usePraxisStore.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  write: false,
  alias: { "@": path.join(root, "src") },
  external: ["@tauri-apps/*"],
  loader: { ".css": "empty", ".png": "empty", ".svg": "empty", ".glb": "empty" },
  logLevel: "silent",
});
const mod = { exports: {} };
new Function("module", "exports", "require", result.outputFiles[0].text)(mod, mod.exports, require);
const { usePraxisStore } = mod.exports;
const S = () => usePraxisStore.getState();
const forge = () => S().agents["a.forge"];
assert.ok(forge(), "store has Forge");

let passed = 0;
function t(name, fn) { fn(); passed += 1; console.log(`  PASS  ${name}`); }

t("a mission dispatch puts Forge on the mission node", () => {
  S().applyEvent({ type: "agent:status", t: 1, agentId: "a.forge", status: "working", taskId: "j.mission.x", areaId: "ventures", orchestrator: true });
  assert.equal(forge().status, "working");
  assert.equal(forge().taskId, "j.mission.x");
});
t("the session census cannot re-anchor a mission-held agent", () => {
  S().applyEvent({ type: "agent:status", t: 2, agentId: "a.forge", status: "working", taskId: "j.praxis.1", areaId: "praxis" });
  assert.equal(forge().taskId, "j.mission.x");
});
t("the session census cannot idle a mission-held agent mid-step", () => {
  S().applyEvent({ type: "agent:status", t: 3, agentId: "a.forge", status: "idle" });
  assert.equal(forge().status, "working");
});
t("the firing decay cannot stand a mission-held agent down mid-step", () => {
  // Live gap found 2026-10-04: the driver says "working" once, then waits minutes on a
  // headless CLI the deck never lists; reconcileFiring idled it after 60 s.
  S().reconcileFiring([], 500, new Map());
  assert.equal(forge().status, "working", "still orbiting the mission node 8 min later");
  assert.equal(forge().taskId, "j.mission.x");
});
t("a live session elsewhere cannot re-anchor a mission-held agent either", () => {
  S().reconcileFiring(["a.forge"], 501, new Map([["a.forge", [{ areaId: "praxis", taskId: "j.praxis.1" }]]]));
  assert.equal(forge().taskId, "j.mission.x");
  assert.equal(forge().areaId, "ventures");
});
t("the mission's own idle releases the agent", () => {
  S().applyEvent({ type: "agent:status", t: 4, agentId: "a.forge", status: "idle", taskId: "j.mission.x", orchestrator: true });
  assert.equal(forge().status, "idle");
});
t("task:stop ends a task's active state without completing it", () => {
  S().applyEvent({ type: "task:start", t: 6, taskId: "j.mission.y" });
  assert.equal(S().tasks["j.mission.y"].active, true);
  S().applyEvent({ type: "task:stop", t: 7, taskId: "j.mission.y" });
  assert.equal(S().tasks["j.mission.y"].active, false);
  assert.notEqual(S().tasks["j.mission.y"].progress, 1, "not marked complete");
});
t("after release the census drives the agent again", () => {
  S().applyEvent({ type: "agent:status", t: 5, agentId: "a.forge", status: "working", taskId: "j.praxis.1", areaId: "praxis" });
  assert.equal(forge().taskId, "j.praxis.1");
});

console.log(`\nPASS — ${passed} passed, 0 failed`);
