/**
 * Contract tests for the Mission thread (src/orchestrator/missionThread.ts).
 *
 * Run: node scripts/test-mission-thread.cjs
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const events = [];
const listeners = new Map();
global.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};
global.window = {
  dispatchEvent(event) {
    events.push(event);
    for (const fn of listeners.get(event.type) ?? []) fn(event);
    return true;
  },
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener(type, fn) {
    listeners.get(type)?.delete(fn);
  },
};

function loadModule(relativePath) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, relativePath)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    write: false,
    alias: { "@": path.join(root, "src") },
    external: ["@tauri-apps/api/*"],
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const M = loadModule("src/orchestrator/missionThread.ts");
let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  PASS  ${name}`);
    });
}

(async () => {
  await test("mission ids and message ids are unique", () => {
    const ids = new Set(Array.from({ length: 50 }, () => M.newMissionId()));
    assert.equal(ids.size, 50);
    const a = M.makeMissionMsg({ missionId: "m1", from: "zach", kind: "mission", text: "x", ts: 5 });
    const b = M.makeMissionMsg({ missionId: "m1", from: "zach", kind: "mission", text: "x", ts: 5 });
    assert.notEqual(a.id, b.id);
    assert.equal(a.ts, 5);
  });

  await test("titles are the first sentence, capped", () => {
    assert.equal(M.missionTitle("Make a concise personal website. Delegate to Codex."), "Make a concise personal website.");
    const long = M.missionTitle("a".repeat(100));
    assert.ok(long.length <= 60 && long.endsWith("…"));
  });

  await test("coerce accepts a message and a persisted agent-chat row; rejects junk", () => {
    const msg = M.makeMissionMsg({
      missionId: "m1",
      from: "praxis",
      kind: "result",
      text: "Done.",
      status: "done",
      artifacts: [
        { kind: "preview", label: "Open preview", target: "file:///C:/x/index.html" },
        { kind: "bogus", label: "x", target: "y" },
        { kind: "folder", label: "Open folder", target: "" },
      ],
    });
    const direct = M.coerceMissionMsg(msg);
    assert.equal(direct.kind, "result");
    assert.equal(direct.artifacts.length, 1, "invalid artifacts are dropped");
    const row = { role: "agent", text: "Done.", ts: msg.ts, meta: msg };
    assert.equal(M.coerceMissionMsg(row).id, msg.id);
    assert.equal(M.coerceMissionMsg({ role: "agent", text: "hi", ts: 1 }), null, "no meta → not a mission row");
    assert.equal(M.coerceMissionMsg({ ...msg, from: "mallory" }), null);
    assert.equal(M.coerceMissionMsg({ ...msg, kind: "shout" }), null);
    assert.equal(M.coerceMissionMsg(null), null);
  });

  await test("posting outside Tauri announces in-window and never throws", async () => {
    const before = events.length;
    const got = [];
    const un = M.subscribeMission((m) => got.push(m));
    const posted = await M.praxisSay("m2", "dispatch", "Vega started building.", { agent: "vega", model: "gpt-6-astra" });
    assert.equal(events.length, before + 1);
    assert.equal(events[events.length - 1].type, M.MISSION_EVENT);
    assert.equal(got.length, 1);
    assert.equal(got[0].id, posted.id);
    // the same message arriving again (e.g. this window's own Tauri broadcast) is ignored
    window.dispatchEvent(new CustomEvent(M.MISSION_EVENT, { detail: posted }));
    assert.equal(got.length, 1, "deduped by id");
    un();
    await M.praxisSay("m2", "progress", "after unsubscribe");
    assert.equal(got.length, 1, "unsubscribe stops delivery");
    assert.deepEqual(await M.loadMissionThread(), [], "no Tauri → empty thread, no throw");
  });

  await test("groupMissions orders missions and derives live status in message order", () => {
    const mk = (missionId, kind, ts, extra = {}) => M.makeMissionMsg({ missionId, from: "praxis", kind, text: kind, ts, ...extra });
    const msgs = [
      mk("a", "mission", 1, { from: "zach", title: "Personal site" }),
      mk("b", "mission", 2, { from: "zach" }),
      mk("a", "plan", 3, { status: "running" }),
      mk("a", "result", 9),
      mk("b", "plan", 4, { status: "running" }),
      mk("b", "failure", 8),
      mk("c", "brief", 10, { from: "atlas", title: "Gmail draft" }),
    ];
    const g = M.groupMissions(msgs);
    assert.deepEqual(g.map((x) => x.missionId), ["a", "b", "c"]);
    assert.equal(g[0].title, "Personal site");
    assert.equal(g[0].status, "done", "a later result beats an earlier running plan");
    assert.equal(g[1].status, "failed");
    assert.equal(g[2].status, "running");
    assert.deepEqual(g[0].msgs.map((m) => m.kind), ["mission", "plan", "result"]);
  });

  console.log(`\nPASS — ${passed} passed, 0 failed`);
})().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
