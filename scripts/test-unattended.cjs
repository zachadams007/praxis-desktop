/** Ownership regressions for scoped versus explicit-global unattended stops. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "src/orchestrator/unattended.ts");
const result = esbuild.buildSync({
  entryPoints: [sourcePath],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  write: false,
  external: ["@tauri-apps/api/*"],
  logLevel: "silent",
});
const mod = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)(require, mod, mod.exports);
const { unattendedOwnerMatches } = mod.exports;

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("unattended ownership guard");

test("exact owner matches", () => {
  assert.equal(unattendedOwnerMatches("voice:one", "voice:one"), true);
});

test("different owner cannot cancel", () => {
  assert.equal(unattendedOwnerMatches("voice:two", "voice:one"), false);
});

test("blank and whitespace owners never mean global", () => {
  assert.equal(unattendedOwnerMatches("voice:one", ""), false);
  assert.equal(unattendedOwnerMatches("voice:one", "   "), false);
});

test("an unowned run cannot be scoped-cancelled", () => {
  assert.equal(unattendedOwnerMatches(null, "voice:one"), false);
});

test("scoped and explicit-global cancellation are separate APIs", () => {
  const src = fs.readFileSync(sourcePath, "utf8");
  assert.match(src, /export function cancelUnattendedRun\(ownerToken: string\)/);
  assert.match(src, /export function cancelAllUnattendedRuns\(\)/);
  assert.doesNotMatch(src, /cancelUnattendedRun\(ownerToken\?: string\)/);
});

console.log(`\nPASS — ${passed} passed, 0 failed`);
