/**
 *
 * Run: node scripts/test-area-for-workspace.cjs
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, location: { pathname: "/" } };

const result = esbuild.buildSync({
  entryPoints: [path.join(root, "src/data/realEvents.ts")],
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
const { areaForWorkspace } = mod.exports;

const cases = [
  ["C:\\Users\\dev\\Desktop\\praxis", "praxis", "the Praxis repo"],
  ["C:\\Users\\dev\\Desktop\\praxis\\src-tauri", "praxis", "inside the Praxis repo"],
  ["C:\\Users\\dev\\Desktop\\praxis-lanes\\lane-c", "praxis", "a Praxis code lane"],
  ["C:\\Users\\dev\\Desktop\\Praxis (non-code)\\design_handoff_flight_deck", "praxis", "Praxis design docs"],
  ["C:\\Users\\dev\\praxis-builds\\very-concise-personal-website-2026-10-01", null, "a website Praxis built - not Praxis"],
  ["C:\\Users\\dev\\Desktop\\command-deck", null, "mission control - not Praxis"],
  ["C:\\Users\\dev\\Desktop", null, "the Desktop"],
  ["C:\\Users\\dev", null, "the home folder"],
  ["", null, "unknown"],
  ["C:\\Users\\dev\\Desktop\\catalyzed-alpha", "catalyzed", "Catalyzed Alpha"],
  ["C:\\Users\\dev\\Desktop\\catalyzed-lanes\\lane-a", "catalyzed", "a Catalyzed lane"],
  ["C:\\Users\\dev\\Desktop\\Studio", "studio", "Studio"],
  ["C:\\Users\\dev\\Desktop\\trading-bot", "finance", "the trading bot"],
];
for (const [cwd, want, why] of cases) {
  assert.equal(areaForWorkspace(cwd), want, `${why}: ${cwd}`);
  console.log(`  PASS  ${why} -> ${want ?? "not shown"}`);
}
console.log(`\nPASS — ${cases.length} passed, 0 failed`);
