/**
 * Re-measure on resume - the automatic half of Restore.
 *
 * Two things have to hold, and the second is the one this codebase keeps getting
 * wrong: the logic must be right, AND it must actually be mounted. `opts.native`
 * and `sovereign_stop` were both correct code that nothing ever called.
 *
 * Run: node scripts/test-live-on-resume.cjs
 */
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail ? " — " + detail : "")); }
};

// ── the decision itself ──────────────────────────────────────────────────────
const src = fs.readFileSync(path.join(ROOT, "src/shared/liveOnResume.ts"), "utf8");
const { code } = esbuild.transformSync(src, { loader: "ts", format: "cjs", target: "es2020" });
const mod = { exports: {} };
new Function("module", "exports", "require", code)(mod, mod.exports, (spec) => {
  if (spec === "react") return { useEffect: () => {} };
  if (spec === "@/shared/visibility") return { isVisible: () => true, onVisibilityChange: () => () => {} };
  throw new Error("unexpected require: " + spec);
});
const { shouldRefreshAfterGap, RESUME_STALE_MS } = mod.exports;

console.log("Re-measure on resume");
const t = 1_700_000_000_000;
ok("a twelve-hour absence re-measures", shouldRefreshAfterGap(t, t + 12 * 3600_000));
ok("a five-minute absence re-measures", shouldRefreshAfterGap(t, t + 5 * 60_000));
ok("alt-tabbing away for two seconds does NOT", !shouldRefreshAfterGap(t, t + 2_000));
ok("the boundary is inclusive", shouldRefreshAfterGap(t, t + RESUME_STALE_MS));
ok("just under the boundary does not fire", !shouldRefreshAfterGap(t, t + RESUME_STALE_MS - 1));
ok("a clock that jumps backwards never fires", !shouldRefreshAfterGap(t, t - 3600_000));

// ── and it is actually wired ─────────────────────────────────────────────────
console.log("Wired into the app");
for (const rel of ["src/App.tsx", "src/command/App.tsx", "src/flightdeck/App.tsx", "src/knowledge/App.tsx"]) {
  const body = fs.readFileSync(path.join(ROOT, rel), "utf8");
  ok(rel + " mounts useLiveOnResume()", /useLiveOnResume\(\)/.test(body) && /from "@\/shared\/liveOnResume"/.test(body));
}
const lib = fs.readFileSync(path.join(ROOT, "src-tauri/src/lib.rs"), "utf8");
ok("refresh_live_state is registered with Tauri", /restore::refresh_live_state/.test(lib));
const restore = fs.readFileSync(path.join(ROOT, "src-tauri/src/restore.rs"), "utf8");
ok("refresh_live_state exists and clears the caches", /pub async fn refresh_live_state/.test(restore) && /elevenlabs_usage::clear_cache/.test(restore));
ok(
  "refresh does NOT broadcast a reload (that is Restore's job)",
  !/fn refresh_live_state[\s\S]*?app\.emit/.test(restore.slice(restore.indexOf("pub async fn refresh_live_state"), restore.indexOf("#[derive(serde::Serialize)]\npub struct RestoreReport"))),
);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
