/**
 * A builder that CAN'T work says why, before any "no build steps" fact.
 *
 * Run: node scripts/test-board-builders.cjs
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
global.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, localStorage: global.localStorage };
global.CustomEvent = class CustomEvent { constructor(t, i = {}) { this.type = t; this.detail = i.detail; } };

const built = esbuild.buildSync({
  stdin: {
    contents: 'export * from "./src/orchestrator/boardContributors"; export { noteToolFailure, forgetAllToolFailures } from "./src/orchestrator/drivers"; export { invalidateAvailability } from "./src/orchestrator/policy";',
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  alias: { "@": path.join(root, "src") },
  external: ["@tauri-apps/*"],
  loader: { ".css": "empty", ".png": "empty", ".svg": "empty", ".glb": "empty" },
  logLevel: "silent",
});
const mod = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(require, mod, mod.exports);
const { generateContributions, noteToolFailure, forgetAllToolFailures, invalidateAvailability } = mod.exports;

const idleJob = (agent) => ({
  agent,
  job: "build steps",
  ts: Date.now(),
  ok: true,
  recent_steps: 0,
  bullets: [`No build steps in the last 24h. Last one 2026-10-01: finished (${agent}).`],
  artifact: "runs.jsonl",
});
// The real app has migrated its breaker defaults; without this marker the stored
// switches are reset to defaults (toolPolicyPersistence.readToolToggles).
localStorage.setItem("praxis.tools.defaults.v7", "7");
const jobs = [idleJob("forge"), idleJob("vega"), idleJob("quill")];
// A real (empty) morning's inputs, shaped like boardMeeting.ts BoardInputs.
const inputs = {
  recent_runs: [], recent_runs_age_days: 3, total_runs_in_ledger: 0, recent_run_note_files: [], open_now: [],
  spend_by_tool: [], models_active: [], research_inbox: "", research_inbox_present: false,
  forge_runs: [], vega_runs: [], latest_org_report: "", latest_org_report_file: "", vault_stats: { present: false },
};
const row = (rows, key) => rows.find((r) => r.key === key);
let passed = 0;
const t = async (name, fn) => { await fn(); passed += 1; console.log(`  PASS  ${name}`); };

(async () => {
  await t("Quill with its breaker open leads with the breaker, not 'no build steps'", async () => {
    localStorage.setItem("praxis.tools.v1", JSON.stringify({ claude: true, codex: true, cursor: false, openrouter: true, hermes: true }));
    invalidateAvailability();
    const rows = await generateContributions(inputs, [], jobs);
    const quill = row(rows, "quill");
    assert.match(quill.bullets[0], /Quill can't work: breaker open/);
    assert.equal(quill.ok, false, "the digest lists it under [unavailable]");
    assert.match(quill.bullets.join(" "), /Last one 2026-10-01/, "the last real step is still reported after the reason");
    // Vega is idle but able - its row stays the plain run-ledger fact.
    assert.match(row(rows, "vega").bullets[0], /^No build steps in the last 24h/);
  });

  await t("Forge while Anthropic refuses Claude Code says that, not 'no build steps'", async () => {
    localStorage.setItem("praxis.tools.v1", JSON.stringify({ claude: true, codex: true, cursor: true, openrouter: true, hermes: true }));
    forgetAllToolFailures();
    noteToolFailure("claude", "claude brain: The vendor is refusing Claude Code");
    invalidateAvailability();
    const rows = await generateContributions(inputs, [], jobs);
    const forge = row(rows, "forge");
    assert.match(forge.bullets[0], /Forge can't work: The vendor is refusing Claude Code/);
    assert.equal(forge.ok, false);
    // Quill's breaker is back on: plain fact again.
    assert.match(row(rows, "quill").bullets[0], /^No build steps in the last 24h/);
  });

  await t("an able, idle builder spends no model call and reports only its ledger fact", async () => {
    forgetAllToolFailures();
    invalidateAvailability();
    const rows = await generateContributions(inputs, [], jobs);
    for (const key of ["forge", "vega", "quill"]) {
      assert.equal(row(rows, key).provider, "run ledger", key);
      assert.match(row(rows, key).bullets[0], /^No build steps in the last 24h/, key);
    }
  });

  console.log(`\nPASS — ${passed} passed, 0 failed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
