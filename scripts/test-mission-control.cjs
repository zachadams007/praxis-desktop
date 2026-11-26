/**
 * Stop a running mission from the Mission panel (missionControl.ts) - owner request 2026-10-10.
 * Run: node scripts/test-mission-control.cjs
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
};
const built = esbuild.buildSync({
  stdin: {
    contents: 'export * from "./src/orchestrator/missionControl"; export { scheduleDeferredMission, deferredMissions } from "./src/orchestrator/missionDeferral";',
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  alias: { "@": path.join(root, "src") },
  external: ["@tauri-apps/*"],
  logLevel: "silent",
});
const mod = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(require, mod, mod.exports);
const mc = mod.exports;

let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log(`  PASS  ${name}`); };

(async () => {
  await t("Stop aborts the run's own signal, and only that mission's", async () => {
    const a = mc.registerMission("m-a");
    const b = mc.registerMission("m-b");
    await mc.requestMissionStop("m-a");
    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, false, "another mission keeps running");
    mc.finishMission("m-a");
    mc.finishMission("m-b");
  });

  await t("a parent stop (Atlas, an owned run) still stops the mission", async () => {
    const parent = new AbortController();
    const c = mc.registerMission("m-c", parent.signal);
    parent.abort();
    assert.equal(c.signal.aborted, true);
    mc.finishMission("m-c");
  });

  await t("a finished mission is no longer stoppable here", async () => {
    mc.registerMission("m-d");
    assert.equal(mc.isMissionRunningHere("m-d"), true);
    mc.finishMission("m-d");
    assert.equal(mc.isMissionRunningHere("m-d"), false);
    assert.equal(mc.stopMissionHere("m-d"), false);
  });

  await t("two runs in one mission (a typed task and a build): Stop stops both, and one finishing keeps the other stoppable", async () => {
    const op = mc.registerMission("m-two");
    const build = mc.registerMission("m-two");
    mc.finishMission("m-two", op);
    assert.equal(mc.isMissionRunningHere("m-two"), true, "the build is still running");
    const op2 = mc.registerMission("m-two");
    await mc.requestMissionStop("m-two");
    assert.equal(build.signal.aborted, true);
    assert.equal(op2.signal.aborted, true);
    assert.equal(op.signal.aborted, false, "a finished run is not touched");
    mc.finishMission("m-two", build);
    mc.finishMission("m-two", op2);
    assert.equal(mc.isMissionRunningHere("m-two"), false);
  });

  await t("Stop on a mission queued for capacity cancels its queued start", async () => {
    mc.scheduleDeferredMission({ missionId: "m-q", goal: "build the thing", at: Date.now() + 3600_000, deferrals: 1 });
    assert.equal(mc.deferredMissions().some((d) => d.missionId === "m-q"), true);
    await mc.requestMissionStop("m-q");
    assert.equal(mc.deferredMissions().some((d) => d.missionId === "m-q"), false);
  });

  console.log(`\nPASS — ${passed} passed, 0 failed`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
