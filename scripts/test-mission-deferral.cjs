/**
 * When every agent is out, a mission waits instead of failing (src/orchestrator/missionDeferral.ts).
 *
 * Run: node scripts/test-mission-deferral.cjs
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
global.window = { dispatchEvent() { return true; }, addEventListener() {}, removeEventListener() {} };
global.CustomEvent = class CustomEvent { constructor(t, i = {}) { this.type = t; this.detail = i.detail; } };

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

const D = loadModule("src/orchestrator/missionDeferral.ts");
const now = new Date(2026, 9, 1, 0, 30).getTime(); // Thu 10/1 00:30 local
const at = (h, m, dayOffset = 0) => new Date(2026, 9, 1 + dayOffset, h, m).getTime();
const out = (tool, retryAt) => ({ tool, usable: false, reason: `${tool} is out of usage`, retryAt, source: "remembered" });
const up = (tool) => ({ tool, usable: true, source: "live" });
const allOut = { claude: out("claude", at(2, 30)), codex: out("codex", at(2, 34)), cursor: out("cursor", at(11, 0, 1)) };
const claudeRefused = { tool: "claude", ok: false, output: "agent_delegate(claude): Claude is out of usage and resets 2:30am" };

let passed = 0;
function t(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

t("every agent out after a capacity refusal -> queued for a minute after the first return", () => {
  const d = D.deferralFor({ steps: [claudeRefused], avail: allOut, deferrals: 0, now });
  assert.ok(d, "should defer");
  assert.equal(d.at, at(2, 30) + D.START_SLACK_MS);
  assert.match(d.text, /Every agent is out right now/);
  assert.match(d.text, /Claude until/);
  assert.match(d.text, /Codex until/);
  assert.match(d.text, /Cursor until/);
  assert.match(d.text, /when Claude is back/);
  assert.match(d.text, /Nothing for you to do/);
});

t("nothing ran because everyone was benched before planning -> still queued", () => {
  assert.ok(D.deferralFor({ steps: [], avail: allOut, deferrals: 0, now }));
});

t("an agent is usable right now -> no deferral (rerouting should have used it)", () => {
  assert.equal(D.deferralFor({ steps: [claudeRefused], avail: { ...allOut, codex: up("codex") }, deferrals: 0, now }), null);
});

t("some step succeeded -> no blind re-run; the failure says what's left", () => {
  const steps = [{ tool: "codex", ok: true, output: "built index.html" }, claudeRefused];
  assert.equal(D.deferralFor({ steps, avail: allOut, deferrals: 0, now }), null);
});

t("a failure that is not about capacity (a bug, a bad prompt) -> no deferral", () => {
  const steps = [{ tool: "claude", ok: false, output: "TypeError: cannot read properties of undefined" }];
  assert.equal(D.deferralFor({ steps, avail: allOut, deferrals: 0, now }), null);
});

t("after MAX_DEFERRALS waits it fails honestly", () => {
  assert.equal(D.deferralFor({ steps: [claudeRefused], avail: allOut, deferrals: D.MAX_DEFERRALS, now }), null);
});

t("no return time known -> waits the default, and says so without naming who", () => {
  const noTimes = { claude: out("claude"), codex: out("codex"), cursor: out("cursor") };
  const d = D.deferralFor({ steps: [claudeRefused], avail: noTimes, deferrals: 0, now });
  assert.equal(d.at, now + D.DEFAULT_WAIT_MS + D.START_SLACK_MS);
  assert.doesNotMatch(d.text, /when \w+ is back/);
  assert.match(d.text, /Claude unavailable/);
});

console.log(`\nPASS — ${passed} passed, 0 failed`);

// ── closing failure text (src/orchestrator/missionText.ts) ──────────────────────
const T = loadModule("src/orchestrator/missionText.ts");
t("failure text: deduped plain reasons, no plumbing prefixes, and what's left", () => {
  const raw = "Forge: agent_delegate(claude): Claude is out of usage and resets 2:30am - route this work to Codex or Cursor until then";
  const steps = [
    { tool: "claude", ok: false, output: raw, why: "Define accurate, concise content", prompt: "x" },
    { tool: "claude", ok: false, output: raw, why: "Deliver the working static site", prompt: "y" },
    { tool: "claude", ok: false, output: raw, why: "Integration and accessibility edits", prompt: "z" },
  ];
  const msg = T.failureMessage({ summary: `${raw}; Forge: unroutable: Codex is out of its 5h usage; Cursor is out of`, steps });
  assert.match(msg, /^Not finished\. What stopped it: /);
  assert.doesNotMatch(msg, /agent_delegate\(|unroutable:/);
  assert.equal((msg.match(/out of usage/g) || []).length, 1, "same reason only once");
  assert.match(msg, /What's left: Define accurate, concise content; Deliver the working static site; Integration and accessibility edits\./);
});
t("failure text: all steps ok but the check never confirmed -> the checker's reason, not 'agents could not complete'", () => {
  const steps = [{ tool: "codex", ok: true, output: "built it", why: "build", prompt: "b" }];
  const msg = T.failureMessage({ summary: "The QA evidence does not show the mobile layout was checked.", steps });
  assert.equal(msg, "Not finished. The final check still had open items: The QA evidence does not show the mobile layout was checked.");
});
t("step labels: say WHAT the agent does - never its preamble, a terse checker note becomes 'Fix: …'", () => {
  assert.equal(T.stepLabel({ why: "Vega builds and verifies the complete dependency-free, ready-to-deploy site.", prompt: "x" }),
    "Vega builds and verifies the complete dependency-free, ready-to-deploy site.");
  assert.equal(T.stepLabel({ why: "", prompt: "You are Vega (Codex) on Praxis's build team — Forge = Claude Code, Vega = Codex, Quill = Cursor — working for Zach.\nBuild index.html, styles.css and script.js from CONTENT.md." }),
    "Build index.html, styles.css and script.js from CONTENT.md.");
  assert.equal(T.stepLabel({ why: "deliverable gate failed", prompt: "You are Vega (Codex) on Praxis's build team.\nRe-run qa/verify.cjs and fix whatever fails." }),
    "Fix: deliverable gate failed - Re-run qa/verify.cjs and fix whatever fails.");
});
t("result text: concise, says WHAT was built, the checks, who did it, who covered, and that the preview is open", () => {
  const steps = [
    { tool: "codex", ok: true, output: "Built index.html and styles.css. All 19 headless file:// checks passed." },
    { tool: "claude", ok: true, output: "Reviewed against the brief; re-ran qa/verify.cjs: 19/19 checks pass." },
  ];
  const msg = T.resultMessage({ minutes: 10.6, title: "Zach | Personal Website", steps, benched: [{ tool: "cursor", standIn: "claude" }], hasPreview: true, previewOpened: true });
  assert.equal(msg, 'Done in 11 min. "Zach | Personal Website" is built - 19/19 checks passed. Vega and Forge did the work (Forge covered for Quill). The preview is open, and it\'s in your Inbox.');
  assert.ok(msg.length < 220, "concise");
  const noPreview = T.resultMessage({ minutes: 0.2, steps: [{ tool: "claude", ok: true, output: "done" }], hasPreview: false, previewOpened: false });
  assert.equal(noPreview, "Done in 1 min. The work is done. Forge did the work. It's in your Inbox.");
});
t("speakable: Atlas reads it without paths, slashes or quotes", () => {
  const said = T.speakable('Done in 11 min. "Zach | Personal Website" is built - 19/19 checks passed. Folder C:\\Users\\dev\\praxis-builds\\site, file:///C:/x/index.html');
  assert.equal(said, "Done in 11 minutes. Zach | Personal Website is built, 19 of 19 checks passed. Folder its folder, the preview");
});
t("failure text: a short human summary is used when no step explains it", () => {
  const msg = T.failureMessage({ summary: "The brain could not verify the site loads.", steps: [] });
  assert.equal(msg, "Not finished. What stopped it: The brain could not verify the site loads.");
});
console.log(`\nPASS — ${passed} passed, 0 failed (with missionText)`);
