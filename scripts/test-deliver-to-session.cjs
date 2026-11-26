/**
 * Flight Deck messages reach the session (src/flightdeck/lib/deliverToSession.ts):
 * routing, honest cast toasts, the reply coming back, and the deliver-when-free queue.
 *
 * Run: node scripts/test-deliver-to-session.cjs
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

const D = loadModule("src/flightdeck/lib/deliverToSession.ts");
const claudeIdle = { id: "00000000-0000-4000-8000-00000000000a", driver: "max", cwd: "C:/Users/dev/Desktop/praxis", working: false };
const claudeBusy = { ...claudeIdle, id: "11111111-2222-3333-4444-555555555555", working: true };
const codexIdle = { id: "codex:00000000000b", driver: "codex", cwd: "C:/x", working: false };
const cursor = { id: "cursor:abc", driver: "cursor", cwd: null, working: false };
const cloud = { id: "praxis::cloud-2", driver: "cloud", cwd: null, working: false };

let passed = 0;
async function t(name, fn) {
  await fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

(async () => {
  await t("route: Claude (any non-tool driver) and Codex resume; Cursor and cloud say why they can't", () => {
    assert.deepEqual(D.deliveryRoute(claudeIdle), { cli: "claude" });
    assert.deepEqual(D.deliveryRoute(codexIdle), { cli: "codex" });
    assert.match(D.deliveryRoute(cursor).unsupported, /Cursor/);
    assert.match(D.deliveryRoute(cloud).unsupported, /cloud/);
  });

  await t("cast plan + toast: deliver now, busy ones when free, unreachable named - never 'CAST TO N' for all", () => {
    const plan = D.planCast([claudeIdle, codexIdle, claudeBusy, cursor]);
    assert.equal(plan.now.length, 2);
    assert.equal(plan.queued.length, 1);
    assert.equal(plan.unreachable.length, 1);
    assert.equal(D.castToast(plan), "⇶ DELIVERING TO 2 SESSIONS · 1 BUSY SESSION GET IT WHEN FREE · 1 SESSION CAN'T TAKE MESSAGES");
    assert.equal(D.castToast(D.planCast([claudeIdle])), "⇶ DELIVERING TO 1 SESSION");
    assert.equal(D.castToast(D.planCast([])), "NO SESSIONS TO DELIVER TO");
  });

  await t("deliver: the CLI driver and session go to session_deliver and the reply comes back", async () => {
    const calls = [];
    const invoke = async (cmd, args) => {
      calls.push([cmd, args]);
      return { reply: "Renamed it.", sessionId: args.sessionId, forked: false };
    };
    const r = await D.deliverToSession(codexIdle, "rename it", invoke);
    assert.deepEqual(r, { ok: true, reply: "Renamed it.", forked: false, sessionId: "codex:00000000000b" });
    assert.deepEqual(calls, [["session_deliver", { driver: "codex", sessionId: "codex:00000000000b", cwd: "C:/x", message: "rename it" }]]);
  });

  await t("deliver: a refusal comes back as a plain reason; Cursor never reaches the backend", async () => {
    const r = await D.deliverToSession(claudeIdle, "hi", async () => { throw "claude is out of usage right now: resets 9pm"; });
    assert.deepEqual(r, { ok: false, reason: "claude is out of usage right now: resets 9pm" });
    let called = false;
    const c = await D.deliverToSession(cursor, "hi", async () => { called = true; });
    assert.equal(c.ok, false);
    assert.equal(called, false);
  });

  await t("queue: a busy session keeps its message; a free or closed one releases it; stale ones expire", () => {
    store.clear();
    const now = Date.now();
    D.enqueueDelivery({ sessionId: "busy", text: "a", at: now, label: "Forge" });
    D.enqueueDelivery({ sessionId: "free", text: "b", at: now, label: "Forge" });
    D.enqueueDelivery({ sessionId: "gone", text: "c", at: now, label: "Vega" });
    D.enqueueDelivery({ sessionId: "free", text: "old", at: now - D.PENDING_MAX_AGE_MS - 1, label: "Forge" });
    const working = { busy: true, free: false };
    const { ready, expired } = D.takeReady((id) => working[id], now);
    assert.deepEqual(ready.map((p) => p.text), ["b", "c"]);
    assert.deepEqual(expired.map((p) => p.text), ["old"]);
    assert.deepEqual(D.pendingDeliveries().map((p) => p.text), ["a"], "only the busy one is still waiting");
    working.busy = false;
    assert.deepEqual(D.takeReady((id) => working[id], now).ready.map((p) => p.text), ["a"]);
    assert.equal(D.pendingDeliveries().length, 0);
  });

  await t("queue: routing and origin console survive until a busy session is free", () => {
    store.clear();
    const p = {
      sessionId: claudeBusy.id,
      text: "land this after the build",
      at: Date.now(),
      label: "Forge",
      driver: "max",
      cwd: "C:/Users/dev/Desktop/praxis",
      channelKey: "lane:praxis-e",
    };
    D.enqueueDelivery(p);
    assert.deepEqual(D.pendingDeliveries(), [p]);
  });

  await t("runLimited: never more than the limit at once, every item runs", async () => {
    let live = 0;
    let peak = 0;
    const done = [];
    await D.runLimited([1, 2, 3, 4, 5], D.DELIVER_CONCURRENCY, async (n) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      done.push(n);
      live -= 1;
    });
    assert.equal(peak, 2);
    assert.deepEqual(done.sort(), [1, 2, 3, 4, 5]);
  });

  await t("DeckApp uses real delivery for session/lane/repo sends, not append-only lane casts", () => {
    const deck = require("node:fs").readFileSync(path.join(root, "src/flightdeck/deck/DeckApp.tsx"), "utf8");
    assert.match(deck, /deliverToSession/);
    assert.match(deck, /planCast\(targets\.map\(deliveryTarget\)\)/);
    assert.match(deck, /enqueueDelivery\(\{ sessionId: s\.id/);
    assert.match(deck, /const bySession = new Map<string, typeof ready>/, "queued turns are serialized per session");
    assert.match(deck, /NO LIVE SESSIONS IN THIS REPO/, "an empty repo is not falsely called locked");
    assert.doesNotMatch(deck, /appendFlightDeckAgentChat\(\{ tool: toolFor\(s\), role: 'zach', text: `\[LANE CAST\]/);
  });

  console.log(`\nPASS — ${passed} passed, 0 failed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
