/** Headless tests for deck spawn-join (pid/cwd, never the synthetic fd- id). */
const path = require("path");
const esbuild = require("esbuild");

function loadModule(relativeEntry) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(__dirname, "..", relativeEntry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    alias: { "@": path.join(__dirname, "../src") },
  });
  const mod = { exports: {} };
  new Function("require", "module", "exports", result.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const model = loadModule("src/flightdeck/deck/model.ts");
const artifact = loadModule("src/shared/artifactPath.ts");

let pass = 0;
let fail = 0;
function ok(condition, label, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const now = 1_700_000_000_000;
const mark = { pid: 4242, cwd: "C:\\Users\\dev\\Desktop\\praxis", driver: "claude", at: now - 5_000 };

ok(
  model.sessionAttribution({ id: "uuid-from-cli", pid: 4242, origin: "manual" }, "C:/Users/dev/Desktop/praxis", [mark], now).manual === false,
  "a Claude card joins a spawn by pid, not by the fd- session id",
);
ok(
  model.sessionAttribution({ id: "uuid-from-cli", pid: 4242, origin: "manual" }, "C:/Users/dev/Desktop/praxis", [mark], now).fresh === true,
  "a pid match inside the fresh window gets the just-spawned treatment",
);
ok(
  model.sessionAttribution({ id: "fd-abc-def", pid: null, origin: "manual" }, "C:/elsewhere", [mark], now).manual === true,
  "the synthetic fd- id never matches a card — join is pid/cwd, not the spawn sessionId",
);

const stale = { ...mark, at: now - model.SPAWN_FRESH_MS - 1 };
ok(
  model.sessionAttribution({ id: "uuid", pid: 4242, origin: "praxis" }, mark.cwd, [stale], now).fresh === false,
  "an old pid match is still praxis (backend origin) but not fresh",
);
ok(
  model.sessionAttribution({ id: "uuid", pid: 4242, origin: "praxis" }, mark.cwd, [stale], now).manual === false,
  "backend origin praxis stays attributed after the fresh window",
);

const codexMark = { pid: 99, cwd: "C:/wt/lane-b", driver: "codex", at: now - 1_000 };
ok(
  model.sessionAttribution({ id: "codex:abc", pid: null, origin: "manual" }, "C:\\wt\\lane-b", [codexMark], now).manual === false,
  "a Codex card with no pid joins a unique recent cwd+driver spawn",
);
ok(
  model.sessionAttribution({ id: "codex:abc", pid: null, origin: "manual" }, "C:\\wt\\lane-b", [codexMark], now + model.SPAWN_FRESH_MS).manual === true,
  "cwd+driver join is refused once the spawn is no longer fresh — two sessions in one folder must not all become PRAXIS",
);

const twins = [
  { pid: 1, cwd: "C:/wt", driver: "codex", at: now - 100 },
  { pid: 2, cwd: "C:/wt", driver: "codex", at: now - 200 },
];
ok(
  model.sessionAttribution({ id: "codex:x", pid: null, origin: "manual" }, "C:/wt", twins, now).manual === true,
  "two Codex spawns in the same cwd do not guess which card is whose",
);

ok(
  model.pidForSpawnedSession({ id: "codex:x", pid: null, cwd: "C:/wt/lane-b", driver: "codex" }, [codexMark])?.pid === 99,
  "STOP fallback finds the unique spawn pid by cwd+driver",
);
ok(
  model.pidForSpawnedSession({ id: "codex:x", pid: null, cwd: "C:/wt", driver: "codex" }, twins) === null,
  "STOP fallback refuses to guess when two pids share cwd+driver",
);

const roots = {
  home: "C:\\Users\\dev",
  vault: artifact.vaultRootFromHome("C:\\Users\\dev"),
  repoRoot: artifact.PRAXIS_REPO_ROOT.replace(/\//g, "\\"),
  praxisData: "C:\\Users\\dev\\AppData\\Local\\Praxis",
};
ok(
  artifact.candidateAbsolutePaths("~/Desktop/note.md", roots)[0].toLowerCase().endsWith("\\users\\dev\\desktop\\note.md"),
  "~ expands to the home directory",
);
ok(
  artifact.candidateAbsolutePaths("src/store/usePraxisStore.ts", roots).some((p) => /src\\store\\usePraxisStore\.ts$/i.test(p)),
  "a repo-relative path is a candidate under the repo root",
);
ok(
  artifact.candidateAbsolutePaths("runs/run-1.md", roots).some((p) => /memory\\runs\\run-1\.md$/i.test(p)),
  "a vault-relative path is a candidate under the memory vault",
);
ok(
  artifact.candidateAbsolutePaths("C:\\Users\\dev\\Desktop\\praxis\\AGENTS.md", roots).length === 1,
  "an absolute path is used as-is, not rewritten",
);

const long = "C:\\Users\\dev\\Desktop\\praxis\\src\\flightdeck\\deck\\DeckApp.tsx";
const toast = artifact.openFailureMessage(long, "The system cannot find the file specified");
ok(toast.includes(long), "the open-failure toast keeps the full path", toast);
ok(!toast.includes("…") || toast.indexOf(long) >= 0, "the path itself is not truncated", toast);
ok(/^Couldn't open /.test(toast), "the toast is one plain sentence", toast);

// Lanes are named by their folder, never their position (2026-09-24: lane-a showed as "LANE C").
for (const [p, isMain, i, want] of [
  ["C:\\Users\\dev\\Desktop\\praxis-lanes\\lane-a", false, 2, "LANE A"],
  ["C:/Users/dev/Desktop/praxis-lanes/lane-e/", false, 0, "LANE E"],
  ["C:/Users/dev/Desktop/trading-bot-lanes/c", false, 0, "LANE C"],
  ["C:/Users/dev/Desktop/trading-bot-lanes/earnings-print-detector", false, 0, "LANE EARNINGS-PRINT-DETECTOR"],
  ["C:/Users/dev/Desktop/praxis", true, 0, "MAIN"],
  [null, false, 3, "LANE D"],
]) {
  const got = model.laneLetterFor(p, isMain, i);
  ok(got === want, `lane ${JSON.stringify(p)} is named ${want}`, got);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
