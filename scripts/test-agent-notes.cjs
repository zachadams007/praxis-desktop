/**
 *
 * Run: node scripts/test-agent-notes.cjs
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

const N = loadModule("src/orchestrator/agentNotes.ts");
const now = Date.UTC(2026, 9, 1, 15, 0);
const min = 60_000;
const deck = (text, ago, extra = {}) => ({ role: "zach", text, ts: now - ago, meta: { source: "flightdeck", driver: "claude", cwd: null, sessionId: null, ...extra } });

let passed = 0;
async function t(name, fn) {
  await fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

(async () => {
  await t("only Zach's agent-level deck notes count - not session messages, casts, steers, replies or other sources", () => {
    const rows = [
      deck("Use the dark palette from now on", 30 * min),
      deck("rename the file", 20 * min, { sessionId: "00000000-0000-4000-8000-00000000000a" }),
      deck("[LANE CAST] run the tests", 10 * min),
      deck("[STEER] stop that", 9 * min),
      { role: "agent", text: "ok", ts: now - 8 * min, meta: { source: "flightdeck" } },
      { role: "zach", text: "from the cockpit", ts: now - 7 * min, meta: { kind: "default" } },
      { role: "zach", text: "voice row", ts: now - 6 * min, meta: "spoken" },
    ];
    assert.deepEqual(N.unreadNotes(rows, 0, now).map((n) => n.text), ["Use the dark palette from now on"]);
  });

  await t("already-picked-up and stale (> 3 days) notes are skipped; at most the newest 5 go", () => {
    const rows = [deck("ancient", 4 * 24 * 60 * min), ...[1, 2, 3, 4, 5, 6, 7].map((i) => deck(`note ${i}`, (10 - i) * min))];
    const since = now - 9 * min + 1; // note 1 was handed over last time
    const got = N.unreadNotes(rows, since, now).map((n) => n.text);
    assert.deepEqual(got, ["note 3", "note 4", "note 5", "note 6", "note 7"]);
  });

  await t("the preamble names them as Zach's and stays off when there are none", () => {
    assert.equal(N.notesPreamble([]), "");
    const p = N.notesPreamble([{ text: "Use the dark   palette", at: 1 }]);
    assert.match(p, /^Notes Zach left for you on Praxis's Flight Deck - follow any that apply to this job:\n- Use the dark palette\n\n$/);
  });

  await t("notes count as read only after markRead (a failed job hands them over again)", async () => {
    store.clear();
    const rows = [deck("Use the dark palette", 5 * min)];
    const read = async (id) => (id === "a.forge" ? rows : []);
    const first = await N.pendingAgentNotes("claude", read, now);
    assert.equal(first.count, 1);
    const again = await N.pendingAgentNotes("claude", read, now);
    assert.equal(again.count, 1, "not consumed until the job ran");
    again.markRead();
    const after = await N.pendingAgentNotes("claude", read, now);
    assert.equal(after.count, 0);
    assert.equal(after.preamble, "");
    const vega = await N.pendingAgentNotes("codex", read, now);
    assert.equal(vega.count, 0, "each agent has its own thread");
  });

  await t("no thread / no Tauri -> no notes, never a throw", async () => {
    const r = await N.pendingAgentNotes("codex", async () => { throw new Error("no tauri"); }, now);
    assert.equal(r.count, 0);
    r.markRead();
    const odd = await N.pendingAgentNotes("cursor", async () => "not an array", now);
    assert.equal(odd.count, 0);
  });

  console.log(`\nPASS — ${passed} passed, 0 failed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
