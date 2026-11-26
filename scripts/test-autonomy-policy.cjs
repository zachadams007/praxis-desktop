/**
 * test-autonomy-policy - the trust dial's two halves must agree.
 *
 * The decision lives twice: `src/shared/autonomyPolicy.ts` for the webview and
 * `src-tauri/src/autonomy.rs` for the shell. Neither side can call the other
 * cheaply across the IPC boundary, so both exist - and two copies of a safety
 * decision drift, which is exactly how the dial ended up with four detents
 * wearing two behaviours in the first place.
 *
 * This asserts the TS half against the CONTRACT, then reads the Rust half as
 * text and checks it encodes the same one. A mismatch here means the dial means
 * something different depending on which process is asking.
 *
 * Run: node scripts/test-autonomy-policy.cjs
 */
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

function loadTs(rel) {
  const file = path.join(__dirname, "..", rel);
  const { code } = esbuild.transformSync(fs.readFileSync(file, "utf8"), {
    loader: "ts",
    format: "cjs",
    target: "es2020",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", code)(mod, mod.exports, (spec) =>
    spec.startsWith("@/") ? loadTs("src/" + spec.slice(2) + ".ts") : require(spec),
  );
  return mod.exports;
}

const { unattendedDecision, isSovereign, levelLabel } = loadTs("src/shared/autonomyPolicy.ts");

let pass = 0,
  fail = 0;
const ok = (cond, msg, extra = "") => {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    fail++;
    console.log("  ✗ " + msg + (extra ? `  — ${extra}` : ""));
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// THE CONTRACT
//
// Read as (allowed, approval) per (level, action).
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nthe ladder");
const CONTRACT = {
  observe: { read: "allow", actuate: "block", sensitive: "block" },
  suggest: { read: "allow", actuate: "block", sensitive: "block" },
  approve: { read: "allow", actuate: "step", sensitive: "step" },
  operator: { read: "allow", actuate: "allow", sensitive: "step" },
  full: { read: "allow", actuate: "allow", sensitive: "allow" },
};
const shapeOf = (level, action) => {
  const d = unattendedDecision(level, action);
  if (!d.allowed) return "block";
  return d.approval === "step" ? "step" : "allow";
};
for (const [level, actions] of Object.entries(CONTRACT)) {
  for (const [action, want] of Object.entries(actions)) {
    ok(shapeOf(level, action) === want, `${level} / ${action} → ${want}`, `got ${shapeOf(level, action)}`);
  }
}

console.log("\nthe promises each detent makes");
ok(shapeOf("full", "sensitive") === "allow",
  "IV · SOVEREIGN clears everything — pay, create an account, submit a form, with NO prompt");
ok(isSovereign("full") && !isSovereign("operator"), "only `full` is sovereign");
ok(shapeOf("approve", "actuate") === "step" && shapeOf("approve", "sensitive") === "step",
  "II · PROPOSE asks before EVERY step, not only the risky ones");
ok(shapeOf("operator", "actuate") === "allow" && shapeOf("operator", "sensitive") === "step",
  "III · EXECUTE is autonomous until a step spends money or speaks in his name");
ok(shapeOf("observe", "read") === "allow",
  "even I · OBSERVE can read — a dial that stopped a run inspecting its own state would break it without protecting anything");

console.log("\nfour detents, four behaviours");
// The original defect: `observe`, `suggest` and `approve` were byte-identical,
// so the dial had four positions and two outcomes.
const detents = ["observe", "approve", "operator", "full"];
const fingerprint = (l) => [shapeOf(l, "actuate"), shapeOf(l, "sensitive")].join("/");
for (let i = 0; i < detents.length; i++) {
  for (let j = i + 1; j < detents.length; j++) {
    ok(fingerprint(detents[i]) !== fingerprint(detents[j]),
      `${detents[i]} and ${detents[j]} behave differently`,
      `both ${fingerprint(detents[i])}`);
  }
}
ok(unattendedDecision("observe", "actuate").reason !== unattendedDecision("suggest", "actuate").reason,
  "observe and suggest give different reasons — a shared string would silently lose a rung");

console.log("\nthe Rust half encodes the same ladder");
const rust = fs.readFileSync(path.join(__dirname, "../src-tauri/src/autonomy.rs"), "utf8");
const body = rust.slice(rust.indexOf("pub fn unattended_decision"), rust.indexOf("fn autonomy_file"));
ok(/ActionClass::Read.*\n.*Decision::Allowed\(Approval::None\)/s.test(body) ||
   /matches!\(action, ActionClass::Read\)/.test(body),
  "Rust allows every read");
ok(/Level::Observe => Decision::Blocked/.test(body), "Rust blocks actuation at Observe");
ok(/Level::Suggest => Decision::Blocked/.test(body), "Rust blocks actuation at Suggest");
ok(/Level::Approve => Decision::Allowed\(Approval::Step\)/.test(body),
  "Rust makes PROPOSE act-and-ask, not block");
ok(/Level::Operator => Decision::Allowed\(if matches!\(action, ActionClass::Sensitive\)/.test(body),
  "Rust makes EXECUTE ask only at a sensitive step");
ok(/Level::Full => Decision::Allowed\(Approval::None\)/.test(body),
  "Rust clears everything at SOVEREIGN");

// The five keys must be the same five, spelled the same way, or the
// autonomy.txt mirror silently degrades to the default on one side only.
const tsKeys = ["observe", "suggest", "approve", "operator", "full"];
for (const k of tsKeys) {
  ok(new RegExp(`"${k}" => Some\\(Level::`).test(rust), `Rust parses the "${k}" key`);
  ok(typeof levelLabel(k) === "string" && levelLabel(k).length > 0, `TS labels "${k}"`);
}
ok(/Level::Parse|fn parse/.test(rust) && /_ => None/.test(rust),
  "Rust rejects an unknown key rather than guessing a level");

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
