/**
 * Regression coverage for Atlas's reversible visible-history reset.
 *
 * Run: node scripts/test-atlas-chat-clear.cjs
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const storage = new Map();
const events = [];

global.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
};
global.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};
global.window = {
  location: { pathname: "/index.html" },
  dispatchEvent(event) { events.push(event); return true; },
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
  new Function("require", "module", "exports", result.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const {
  ATLAS_CHAT_CLEARED_THROUGH_KEY,
  ATLAS_CHAT_CLEAR_EVENT,
  clearAtlasChat,
  coerceAtlasChatClear,
  mirrorRealtimeTurn,
  readAtlasChatClearedThrough,
  turnsSinceAtlasChatClear,
  turnsWithinAtlasChatWindow,
} = loadModule("src/voice/atlasChatBridge.ts");

let passed = 0;
function test(name, fn) {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ✓ ${name}`);
  });
}

(async () => {
  console.log("Atlas clear chat");

  await test("filters canonical and legacy rows before the saved cutoff while keeping later turns", () => {
    const rows = [
      { role: "zach", text: "legacy", ts: 100 },
      { role: "agent", text: "canonical", ts: 200 },
      { role: "zach", text: "new", ts: 300 },
    ];
    assert.deepEqual(turnsSinceAtlasChatClear(rows, 200).map((row) => row.text), ["canonical", "new"]);
    assert.deepEqual(turnsSinceAtlasChatClear(rows, 0).map((row) => row.text), ["legacy", "canonical", "new"]);
  });

  await test("rejects malformed boundaries and ignores this window's echoed clear", () => {
    storage.set(ATLAS_CHAT_CLEARED_THROUGH_KEY, "not-a-timestamp");
    assert.equal(readAtlasChatClearedThrough(), 0);
    assert.equal(coerceAtlasChatClear({ clearedThrough: 120, origin: "index.html" }), null);
    assert.deepEqual(coerceAtlasChatClear({ clearedThrough: 120, origin: "command.html" }), { clearedThrough: 120 });
    assert.equal(coerceAtlasChatClear({ clearedThrough: -1 }), null);
  });

  await test("clear saves the cutoff, announces it locally, and resets realtime de-duplication", async () => {
    events.length = 0;
    storage.clear();
    mirrorRealtimeTurn("zach", "same words");
    const result = await clearAtlasChat();
    mirrorRealtimeTurn("zach", "same words");

    assert.equal(readAtlasChatClearedThrough(), result.clearedThrough);
    assert.equal(events.filter((event) => event.type === ATLAS_CHAT_CLEAR_EVENT).length, 1);
    assert.equal(events.filter((event) => event.type === "praxis:atlas-turn").length, 2);
  });

  await test("outdated turns fall off on their own, without a button press", async () => {
    const HOUR = 3600000;
    const now = Date.UTC(2026, 8, 11, 12, 0, 0);
    const turns = [
      { role: "zach", text: "two days ago", ts: now - 48 * HOUR },
      { role: "agent", text: "yesterday evening", ts: now - 20 * HOUR },
      { role: "zach", text: "this morning", ts: now - 4 * HOUR },
      { role: "agent", text: "just now", ts: now - 1000 },
    ];
    assert.deepEqual(
      turnsWithinAtlasChatWindow(turns, now).map((t) => t.text),
      ["this morning", "just now"],
    );

    // A cap by COUNT would cut mid-exchange, leaving an answer with no question.
    assert.equal(
      turnsWithinAtlasChatWindow(
        [{ role: "zach", text: "q", ts: now - HOUR }, { role: "agent", text: "a", ts: now - HOUR + 10 }],
        now,
      ).length,
      2,
    );

    // Losing a real message is worse than showing an old one.
    assert.equal(
      turnsWithinAtlasChatWindow(
        [{ role: "zach", text: "no ts", ts: 0 }, { role: "agent", text: "nan", ts: Number.NaN }],
        now,
      ).length,
      2,
    );

    assert.equal(turnsWithinAtlasChatWindow(turns, now, 0).length, 4);
  });

  console.log(`\nPASS — ${passed} passed, 0 failed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
