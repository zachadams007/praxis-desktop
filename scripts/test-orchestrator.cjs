/**
 * test-orchestrator - headless logic test for the Praxis orchestrator's PURE
 * logic (plan JSON parsing, verify-verdict parsing, iteration budget clamping,
 * the cross-off token-overlap matcher, and claude model coercion).
 *
 * Mirrors scripts/test-voice-commands.cjs exactly: transpile the real
 * src/orchestrator/*.ts on the fly with esbuild (no dep added; vite already
 * bundles it) and exercise the exported functions directly - no vitest/jest,
 * no re-implementation of the logic under test.
 *
 * The orchestrator files have real `@/...` and sibling imports (unlike
 * commands.ts, which has none), so this harness adds a tiny recursive module
 * loader: each src/orchestrator/*.ts file is transformed independently and
 * executed via `new Function("module","exports","require", code)`, with a
 * `require` shim that either (a) resolves sibling orchestrator modules
 * through the SAME loader (so real logic like resolveToolOrNull is genuinely
 * exercised, not re-stubbed), or (b) returns a minimal stub for `@/...`
 * modules the pure logic under test never actually calls (eventBus.emit is a
 * no-op recorder; Tauri/event-bus side effects are irrelevant to parsing/
 * scoring/clamping logic). `localStorage` is stubbed as a global the tests
 * can set/clear per-case, since Node has no browser storage.
 *
 * Run: node scripts/test-orchestrator.cjs
 */
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const ORCH_DIR = path.join(__dirname, "../src/orchestrator");

// ── Minimal localStorage stub (Node has none) ─────────────────────────────────
class FakeLocalStorage {
  constructor() {
    this._map = new Map();
  }
  getItem(k) {
    return this._map.has(k) ? this._map.get(k) : null;
  }
  setItem(k, v) {
    this._map.set(k, String(v));
  }
  removeItem(k) {
    this._map.delete(k);
  }
  clear() {
    this._map.clear();
  }
}
global.localStorage = new FakeLocalStorage();

// ── Recursive loader for src/orchestrator/*.ts ────────────────────────────────
const moduleCache = new Map();
const missionEvents = [];

const sharedCache = new Map();
/** Compile a real `@/shared/*` module for the headless harness. */
function loadSharedModule(spec) {
  const file = path.join(__dirname, "../src", spec.slice(2) + ".ts");
  if (sharedCache.has(file)) return sharedCache.get(file);
  const compiled = esbuild.transformSync(fs.readFileSync(file, "utf8"), {
    loader: "ts",
    format: "cjs",
    target: "es2020",
  }).code;
  const m = { exports: {} };
  sharedCache.set(file, m.exports);
  new Function("module", "exports", "require", compiled)(m, m.exports, (sp) =>
    sp.startsWith("@/shared/")
      ? loadSharedModule(sp)
      : sp.startsWith("@/orchestrator/")
        ? loadOrchModule("./" + sp.slice("@/orchestrator/".length))
        : require(sp),
  );
  sharedCache.set(file, m.exports);
  return m.exports;
}

const plainCache = new Map();
/** Transform and run a TS module that imports nothing (or only types). */
function loadPlainModule(file) {
  if (plainCache.has(file)) return plainCache.get(file);
  const { code } = esbuild.transformSync(fs.readFileSync(file, "utf8"), { loader: "ts", format: "cjs", target: "es2020" });
  const m = { exports: {} };
  plainCache.set(file, m.exports);
  new Function("module", "exports", "require", code)(m, m.exports, (sp) => {
    throw new Error(`loadPlainModule(${path.basename(file)}): unexpected require("${sp}")`);
  });
  plainCache.set(file, m.exports);
  return m.exports;
}

function loadOrchModule(specifier) {
  // specifier is either "./foo" (sibling orchestrator file) - resolved here.
  const file = path.join(ORCH_DIR, specifier.replace(/^\.\//, "") + ".ts");
  if (moduleCache.has(file)) return moduleCache.get(file);

  const src = fs.readFileSync(file, "utf8");
  // `supported: { "dynamic-import": false }` lowers `import("./x")` to a require()
  // call, so the orchestrator's lazy imports go through shimRequire like every
  // static import. Left native, Node resolved them relative to scripts/ and could
  // never load them - so no case could exercise tryOrchestrate end to end.
  const { code } = esbuild.transformSync(src, {
    loader: "ts",
    format: "cjs",
    target: "es2020",
    supported: { "dynamic-import": false },
  });
  const mod = { exports: {} };
  moduleCache.set(file, mod.exports); // set before running to break cycles

  const shimRequire = (spec) => {
    if (spec.startsWith("./") || spec.startsWith("../")) {
      return loadOrchModule(spec);
    }
    if (spec === "@/voice/commands") {
      // Loaded for REAL: submitClassify's whole job is to decide which clauses are
      // control commands, so a stub here would test the classifier against a guess.
      // commands.ts has no imports, so it runs headless unmodified.
      return loadPlainModule(path.join(__dirname, "..", "src", "voice", "commands.ts"));
    }
    if (spec === "@/data/eventBus") {
      // Pure logic under test never inspects emitted events - record them
      // in case a case wants to assert on side effects later.
      return { eventBus: { emit: (e) => missionEvents.push(e), emitOrchestrator: (e) => missionEvents.push(e) } };
    }
    if (spec === "@/store/usePraxisStore") return { usePraxisStore: { getState: () => ({ fileMissionNode: () => ({ taskId: "j.test-mission", areaId: "ventures" }) }) } };
    if (spec === "@/data/schema") {
      return {}; // type-only in real usage; nothing to export at runtime
    }
    if (spec === "@/data/graph") {
      const labels = {
        catalyzed: "Catalyzed Alpha",
        finance: "Finance",
        praxis: "Praxis",
      };
      return {
        buildGraph: () => ({
          byId: new Map(Object.entries(labels).map(([id, label]) => [id, { id, label }])),
        }),
      };
    }
    if (spec === "@/data/journey") {
      const STATUS_RANK = { done: 0, active: 1, next: 2, later: 3 };
      const storyOrder = (milestones) => [...milestones]
        .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.areaId.localeCompare(b.areaId) || a.order - b.order)
        .map((milestone) => milestone.id);
      const nextUp = (milestones) => {
        const byId = new Map(milestones.map((milestone) => [milestone.id, milestone]));
        return storyOrder(milestones).map((id) => byId.get(id)).find((milestone) => milestone.status === "next") ?? null;
      };
      return { STATUS_RANK, storyOrder, nextUp };
    }
    if (spec === "@/command/controlStore") {
      return {}; // type-only (ExecMode) in policy.ts
    }
    if (spec === "@/command/todoStore") {
      return { upcomingTaskTexts: () => [] };
    }
    if (spec === "@/command/fleetStore") {
      // Fleet panel default-model seam (policy.ts#defaultModelFor, orchestrator.ts's
      // Lens QA model read) - pure logic under test never sets a fleet selection, so
      // "no override" (undefined / "") is the correct headless behavior.
      return {
        defaultModelForTool: (tool) => ({ claude: "opus", codex: "gpt-5.6-sol", cursor: undefined })[tool],
        getFleetModel: () => "",
      };
    }
    if (spec === "@/shared/brainPersistence") {
      // Brain-default migration is covered by test-brain-routing.cjs. This
      // harness only needs the runtime reader's raw storage seam.
      return { brainRawAfterDefaultMigration: (storage) => storage.getItem("praxis.brain.v1") };
    }
    if (spec === "@/shared/toolPolicyPersistence") {
      const defaults = { claude: false, codex: true, cursor: false, openrouter: false, hermes: true, "computer-use": true };
      return {
        TOOL_DEFAULTS: defaults,
        readToolToggles: (storage) => {
          let parsed = {};
          try { parsed = JSON.parse(storage.getItem("praxis.tools.v1") || "{}"); } catch {}
          return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, typeof parsed[key] === "boolean" ? parsed[key] : value]));
        },
      };
    }
    if (spec.startsWith("@/shared/")) {
      // Load these for REAL rather than stubbing them. `@/shared/autonomy` and
      // `@/shared/autonomyPolicy` are the trust dial itself, and a stub would
      // let the orchestrator's autonomy checks pass against a fiction - the
      // exact failure mode this whole change is about. Both are pure and guard
      // their localStorage access, so they run headless unmodified.
      return loadSharedModule(spec);
    }
    if (spec === "@tauri-apps/api/core" || spec === "@tauri-apps/api/event") {
      // The end-to-end chain case installs a fake backend; every other case keeps
      // the old contract (reaching Tauri is a failure).
      if (global.__praxisFakeInvoke) {
        return spec === "@tauri-apps/api/core"
          ? { invoke: (cmd, args) => global.__praxisFakeInvoke(cmd, args || {}) }
          : { emit: async () => {}, listen: async () => () => {} };
      }
      throw new Error(`stub: ${spec} not available in headless test`);
    }
    throw new Error(`test-orchestrator: no stub for require("${spec}")`);
  };

  new Function("module", "exports", "require", code)(mod, mod.exports, shimRequire);
  moduleCache.set(file, mod.exports);
  return mod.exports;
}

const orchestrator = loadOrchModule("./orchestrator");
const drivers = loadOrchModule("./drivers");
const policy = loadOrchModule("./policy");
const skills = loadOrchModule("./skills");
const supervision = loadOrchModule("./supervision");
const responder = loadOrchModule("./respond");

const { parsePlan, parseVerdict, iterationBudget, bestTaskMatch, modelForResolvedStep, nativeFlowRoute } = orchestrator;
const { sanitizeClaudeModel } = drivers;
const { resolveToolOrNull } = policy;
const { skillNameFromGoal, isCaptureEligible, deriveSkill, resolveSkill } = skills;
const { greeting, respond } = responder;
const {
  SUPERVISION_MAX_REPROMPTS,
  parseDelegationVerdict,
  evaluateDelegationPrompt,
  repromptText,
  superviseDelegation,
} = supervision;

// ── Test scaffolding (same style as test-voice-commands.cjs) ─────────────────
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
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("roadmap response truthfulness");
{
  const milestones = [
    { id: "cat.done", areaId: "catalyzed", label: "Feed", status: "done", order: 10 },
    { id: "praxis.active", areaId: "praxis", label: "Runtime bridge", status: "active", order: 10 },
    { id: "praxis.next", areaId: "praxis", label: "Cost plan", status: "next", order: 20 },
    { id: "finance.active", areaId: "finance", label: "Spend dashboard", status: "active", order: 10 },
  ];
  const opening = greeting(milestones);
  ok(
    opening.includes("3 roadmap lanes, 2 milestones marked active in the plan"),
    "greeting labels journey-active milestones as roadmap state",
    opening,
  );
  const status = respond(milestones, "status").text;
  ok(status.includes("plan active"), "status reply labels active milestones as plan state", status);
  const branch = respond(milestones, "praxis").text;
  ok(
    branch.includes('"Runtime bridge" is marked active in the roadmap'),
    "branch reply explicitly distinguishes roadmap activity",
    branch,
  );
  for (const query of ["hello", "status", "praxis", "what's next", "done", "something else"]) {
    const reply = respond(milestones, query).text;
    ok(!/\b(live now|is live)\b/i.test(reply), `planner reply never invents live runtime state: ${query}`, reply);
  }
}

console.log("execution routing");
{
  const authored = { tool: "claude", model: "opus" };
  ok(
    modelForResolvedStep(authored, "codex") === "gpt-5.6-sol",
    "policy reroute discards the source tool's incompatible model pin",
  );
  ok(modelForResolvedStep(authored, "claude") === "opus", "same-tool execution preserves its authored model pin");
}
{
  localStorage.clear();
  let route = nativeFlowRoute("codex");
  ok(route?.tool === "codex" && route.model === "gpt-5.6-sol", "native flow uses enabled Codex subscription by default");

  localStorage.setItem("praxis.tools.v1", JSON.stringify({ claude: true, codex: false, cursor: false }));
  route = nativeFlowRoute("codex");
  ok(route?.tool === "claude" && route.model === "opus", "native flow honors breakers and reroutes driver + model together");

  localStorage.setItem("praxis.tools.v1", JSON.stringify({ claude: false, codex: false, cursor: false }));
  ok(nativeFlowRoute("codex") === null, "native flow fails closed when every coding rail is disabled");
  localStorage.clear();
}

// ══════════════════════════════════════════════════════════════════════════
// 1. Plan JSON parsing (parsePlan)
// ══════════════════════════════════════════════════════════════════════════
console.log("plan parsing (parsePlan)");
{
  // Valid plan, multiple steps, no model field
  const raw = JSON.stringify({
    steps: [
      { tool: "claude", prompt: "write the login form", why: "core UI" },
      { tool: "codex", prompt: "wire up the API", why: "backend" },
    ],
    summary: "Build login flow",
  });
  const plan = parsePlan(raw);
  ok(
    plan !== null && plan.steps.length === 2 && plan.summary === "Build login flow",
    "valid plan JSON → 2 steps parsed",
    plan ? JSON.stringify(plan) : "null",
  );
  ok(
    plan && deepEq(plan.steps.map((step) => step.tool), ["claude", "codex"]),
    "valid subscription tools are preserved for policy gating",
  );
}
{
  const plan = parsePlan(JSON.stringify({
    steps: [{ tool: "codex", prompt: "write file", expectedFiles: ["src\\app.ts", "../escape.ts", "*.ts"], why: "write" }],
    summary: "files",
  }));
  ok(plan && deepEq(plan.steps[0].expectedFiles, ["src/app.ts"]),
    "explicit artifact contract normalizes separators and rejects traversal or globs", JSON.stringify(plan));
}

{
  // Code-fenced JSON (```json ... ```)
  const raw = "```json\n" + JSON.stringify({ steps: [{ tool: "claude", prompt: "do it", why: "x" }], summary: "s" }) + "\n```";
  const plan = parsePlan(raw);
  ok(plan !== null && plan.steps.length === 1 && plan.steps[0].prompt === "do it", "code-fenced JSON plan → parsed after fence strip", plan ? JSON.stringify(plan) : "null");
}

{
  // Fenced with bare ``` (no "json" language tag)
  const raw = "```\n" + JSON.stringify({ steps: [{ tool: "cursor", prompt: "polish UI", why: "x" }], summary: "s" }) + "\n```";
  const plan = parsePlan(raw);
  ok(plan !== null && plan.steps[0].tool === "cursor", "bare-fenced JSON plan → parsed with Cursor rail preserved");
}

{
  // Malformed JSON → null (caller falls back to fallbackPlan)
  const plan = parsePlan("this is not json at all {{{");
  ok(plan === null, "malformed JSON → parsePlan returns null (caller falls back)");
}

{
  // Valid JSON but wrong shape (no steps array) → null
  const plan = parsePlan(JSON.stringify({ foo: "bar" }));
  ok(plan === null, "valid JSON but missing steps[] → null");
}

{
  // steps present but empty/all-invalid → synthesized single fallback step from summary
  const raw = JSON.stringify({ steps: [{ tool: "not-a-tool", prompt: "x" }], summary: "do the thing" });
  const plan = parsePlan(raw);
  ok(
    plan !== null && plan.steps.length === 1 && plan.steps[0].why === "fallback" && plan.steps[0].prompt === "do the thing",
    "all-invalid steps → single synthesized fallback step using summary",
    plan ? JSON.stringify(plan) : "null",
  );
}

{
  // Tool-compatible model choices survive parsing; drivers perform final CLI sanitation.
  const raw = JSON.stringify({
    steps: [
      { tool: "claude", prompt: "architecture pass", why: "design", model: "opus" },
      { tool: "codex", prompt: "grunt refactor", why: "bulk", model: "gpt-5.5" },
      { tool: "claude", prompt: "no model specified", why: "x" },
    ],
    summary: "s",
  });
  const plan = parsePlan(raw);
  ok(
    plan &&
      plan.steps[0].model === "opus" &&
      plan.steps[1].model === "gpt-5.5" &&
      plan.steps[2].model === undefined,
    "Claude and Codex model choices are preserved for their requested rails",
    plan ? JSON.stringify(plan.steps) : "null",
  );
}

{
  // model field that's just whitespace → undefined (trimmed away)
  const raw = JSON.stringify({ steps: [{ tool: "claude", prompt: "x", why: "y", model: "   " }], summary: "s" });
  const plan = parsePlan(raw);
  ok(plan && plan.steps[0].model === undefined, "whitespace-only model field → undefined");
}

// ══════════════════════════════════════════════════════════════════════════
// 2. Verify-verdict parsing (parseVerdict)
// ══════════════════════════════════════════════════════════════════════════
console.log("\nverify-verdict parsing (parseVerdict)");
{
  const raw = JSON.stringify({ done: true, reason: "all checks pass", steps: [], summary: "shipped" });
  const v = parseVerdict(raw);
  ok(v !== null && v.done === true && v.reason === "all checks pass" && v.steps.length === 0, "done:true verdict parsed with empty steps");
}

{
  const raw = JSON.stringify({
    done: false,
    reason: "tests still failing",
    steps: [{ tool: "claude", prompt: "fix the failing test", why: "corrective" }],
    summary: "in progress",
  });
  const v = parseVerdict(raw);
  ok(v !== null && v.done === false && v.steps.length === 1 && v.steps[0].prompt === "fix the failing test", "done:false verdict parsed with corrective steps");
}

{
  // Fenced verdict JSON
  const raw = "```json\n" + JSON.stringify({ done: true, reason: "ok", steps: [], summary: "s" }) + "\n```";
  const v = parseVerdict(raw);
  ok(v !== null && v.done === true, "code-fenced verdict JSON → parsed after fence strip");
}

{
  // Missing `done` (not boolean) → null
  const v = parseVerdict(JSON.stringify({ reason: "no done field", steps: [] }));
  ok(v === null, "verdict missing boolean `done` field → null");
}

{
  // Malformed JSON → null
  const v = parseVerdict("not json {{{");
  ok(v === null, "malformed verdict JSON → null");
}

// ══════════════════════════════════════════════════════════════════════════
// 3. Iteration budget clamping (iterationBudget)
// ══════════════════════════════════════════════════════════════════════════
console.log("\niteration budget clamping (iterationBudget)");
{
  localStorage.clear();
  const n = iterationBudget(undefined);
  ok(n === 5, `no opts, no localStorage → default 5 (got ${n})`);
}

{
  localStorage.clear();
  const n = iterationBudget({ maxIterations: 3 });
  ok(n === 3, `opts.maxIterations=3 → 3 (got ${n})`);
}

{
  localStorage.clear();
  const n = iterationBudget({ maxIterations: 99 });
  ok(n === 10, `opts.maxIterations=99 → clamped to 10 (got ${n})`);
}

{
  // maxIterations=0 is FALSY, so the `opts?.maxIterations && …` guard skips the
  // opts branch entirely (0 is not "no override", it's treated as absent) -
  // falls through to localStorage (empty here) → default 5, NOT clamped to 1.
  localStorage.clear();
  const n = iterationBudget({ maxIterations: 0 });
  ok(n === 5, `opts.maxIterations=0 is falsy → falls through to default 5, not clamped to 1 (got ${n})`);
}

{
  localStorage.clear();
  const n = iterationBudget({ maxIterations: -5 });
  ok(n === 1, `opts.maxIterations=-5 → clamped to 1 (got ${n})`);
}

{
  // opts absent → falls through to localStorage value
  localStorage.clear();
  localStorage.setItem("praxis.orchestrator.maxiters.v1", "7");
  const n = iterationBudget(undefined);
  ok(n === 7, `no opts, localStorage=7 → 7 (got ${n})`);
}

{
  // opts present but falsy maxIterations (0) → the opts branch requires truthy,
  // so 0 falls through to localStorage rather than short-circuiting at opts.
  localStorage.clear();
  localStorage.setItem("praxis.orchestrator.maxiters.v1", "4");
  const n = iterationBudget({ maxIterations: 0 });
  ok(n === 4, `opts.maxIterations=0 (falsy) → falls through to localStorage=4 (got ${n})`);
}

{
  // localStorage holds an out-of-range value → clamped
  localStorage.clear();
  localStorage.setItem("praxis.orchestrator.maxiters.v1", "500");
  const n = iterationBudget(undefined);
  ok(n === 10, `localStorage=500 → clamped to 10 (got ${n})`);
}

{
  // localStorage holds garbage → falls back to default
  localStorage.clear();
  localStorage.setItem("praxis.orchestrator.maxiters.v1", "not-a-number");
  const n = iterationBudget(undefined);
  ok(n === 5, `localStorage="not-a-number" → default 5 (got ${n})`);
  localStorage.clear();
}

// ── unattended: true - the "go do everything" ceiling (500, not 10) ──────────
// This is the exact mechanism Pending #1 wires up: hybridRouter's UNATTENDED
// path calls orchestrate(goal, { unattended: true }), and THIS is what makes
// that flag actually matter - without it every run silently caps at 10.
{
  localStorage.clear();
  const n = iterationBudget({ unattended: true });
  ok(n === 500, `opts.unattended=true, no maxIterations → default ceiling 500 (got ${n})`);
}

{
  localStorage.clear();
  const n = iterationBudget({ unattended: true, maxIterations: 200 });
  ok(n === 200, `opts.unattended=true, maxIterations=200 → 200, under the 500 ceiling (got ${n})`);
}

{
  localStorage.clear();
  const n = iterationBudget({ unattended: true, maxIterations: 9999 });
  ok(n === 500, `opts.unattended=true, maxIterations=9999 → clamped to 500, not 10 (got ${n})`);
}

{
  // Same localStorage value reads as an unattended-ceiling number when unattended,
  // but stays clamped to 10 for an ordinary interactive call - proves the two
  // ceilings are genuinely independent, not just a bigger default.
  localStorage.clear();
  localStorage.setItem("praxis.orchestrator.maxiters.v1", "300");
  const interactive = iterationBudget(undefined);
  const unattended = iterationBudget({ unattended: true });
  ok(interactive === 10, `interactive call clamps localStorage=300 to 10 (got ${interactive})`);
  ok(unattended === 300, `unattended call honors localStorage=300 under the 500 ceiling (got ${unattended})`);
  localStorage.clear();
}

{
  // unattended:false is explicitly the interactive ceiling - not a typo for undefined.
  localStorage.clear();
  const n = iterationBudget({ unattended: false, maxIterations: 999 });
  ok(n === 10, `opts.unattended=false, maxIterations=999 → clamped to interactive ceiling 10 (got ${n})`);
}

// ══════════════════════════════════════════════════════════════════════════
// 4. Cross-off token-overlap matcher (bestTaskMatch)
// ══════════════════════════════════════════════════════════════════════════
console.log("\ncross-off token-overlap matcher (bestTaskMatch)");
{
  // Exact match: task text is fully contained in the goal (100% overlap)
  const tasks = [{ text: "wire up voice commands" }];
  const m = bestTaskMatch("please wire up voice commands for Praxis today", tasks);
  ok(m !== null && m.text === "wire up voice commands", "exact task-text-in-goal → matched (task text is the needle, goal is haystack)", m ? JSON.stringify(m) : "null");
}

{
  // >=60% overlap hit: 3 of 4 task tokens present in the goal
  const tasks = [{ text: "fix the login page bug" }]; // 5 tokens: fix,the,login,page,bug
  const goal = "please fix the login page today"; // has fix,the,login,page (4/5 = 80%)
  const m = bestTaskMatch(goal, tasks);
  ok(m !== null && m.score >= 0.6, `>=60% overlap ("${goal}" vs task) → hit`, m ? JSON.stringify(m) : "null");
}

{
  // <60% overlap → miss (null)
  const tasks = [{ text: "rebuild the entire memory galaxy graph renderer" }]; // 7 tokens
  const goal = "rebuild the login form"; // only "rebuild","the" overlap (2/7 ≈ 28%)
  const m = bestTaskMatch(goal, tasks);
  ok(m === null, `<60% overlap → miss (got ${m ? JSON.stringify(m) : "null"})`);
}

{
  // Empty tasks list → null, no crash
  const m = bestTaskMatch("any goal text here", []);
  ok(m === null, "empty tasks list → null (no crash)");
}

{
  // Multiple candidate tasks - picks the highest-scoring one
  const tasks = [
    { text: "totally unrelated database migration work" },
    { text: "fix the voice grammar bug" },
    { text: "polish the memory galaxy" },
  ];
  const goal = "fix the voice grammar bug in the parser";
  const m = bestTaskMatch(goal, tasks);
  ok(m !== null && m.text === "fix the voice grammar bug", "multiple candidates → highest-overlap task wins", m ? JSON.stringify(m) : "null");
}

{
  // Task with only punctuation/empty tokens → skipped without crashing
  const tasks = [{ text: "..." }, { text: "ship the release build" }];
  const goal = "ship the release build tonight";
  const m = bestTaskMatch(goal, tasks);
  ok(m !== null && m.text === "ship the release build", "punctuation-only task text ignored, real match still found");
}

// ══════════════════════════════════════════════════════════════════════════
// 5. Claude model coercion (sanitizeClaudeModel, drivers.ts)
// ══════════════════════════════════════════════════════════════════════════
console.log("\nclaude model coercion (sanitizeClaudeModel)");
{
  ok(sanitizeClaudeModel("haiku") === "sonnet", 'haiku → coerced to "sonnet"');
}
{
  ok(sanitizeClaudeModel("Claude-Haiku-4") === "sonnet", 'any haiku-containing label (mixed case) → coerced to "sonnet"');
}
{
  ok(sanitizeClaudeModel("opus") === "opus", '"opus" passes through unchanged');
}
{
  ok(sanitizeClaudeModel("sonnet") === "sonnet", '"sonnet" passes through unchanged');
}
{
  ok(sanitizeClaudeModel("claude-3-7-sonnet") === "claude-3-7-sonnet", 'full "claude-…" id passes through unchanged');
}
{
  ok(sanitizeClaudeModel("z-ai/glm-5.1") === undefined, "unknown brain-model id (not a claude alias) → undefined (CLI default applies)");
}
{
  ok(sanitizeClaudeModel(undefined) === undefined, "no model given → undefined");
}
{
  ok(sanitizeClaudeModel("   ") === undefined, "whitespace-only model → undefined");
}

// ══════════════════════════════════════════════════════════════════════════
// Bonus: resolveToolOrNull fallback ordering (policy.ts), exercised via the
// real localStorage-backed toggle map - not re-stubbed logic.
// ══════════════════════════════════════════════════════════════════════════
console.log("\ntool fallback ordering (resolveToolOrNull, policy.ts)");
{
  localStorage.clear();
  const t = resolveToolOrNull("claude");
  ok(t === "codex", "disabled-by-default Claude request → Codex-primary fallback");
}
{
  localStorage.clear();
  localStorage.setItem("praxis.tools.v1", JSON.stringify({ claude: true, codex: true, cursor: false }));
  localStorage.setItem("praxis.tools.defaults.v4", "4");
  const t = resolveToolOrNull("claude");
  ok(t === "claude", "explicitly enabled Claude request stays on Claude");
}
{
  localStorage.clear();
  localStorage.setItem("praxis.tools.v1", JSON.stringify({ claude: false, codex: false, cursor: true }));
  localStorage.setItem("praxis.tools.defaults.v4", "4");
  const t = resolveToolOrNull("cursor");
  ok(t === "cursor", "explicitly enabled Cursor request stays on Cursor");
}
{
  localStorage.clear();
  localStorage.setItem("praxis.tools.v1", JSON.stringify({ claude: false }));
  localStorage.setItem("praxis.tools.defaults.v4", "4");
  const t = resolveToolOrNull("claude");
  ok(t === "codex", "requested tool disabled → falls back to next enabled coding tool in order", `got ${t}`);
}
{
  localStorage.clear();
  localStorage.setItem("praxis.tools.v1", JSON.stringify({ claude: false, codex: false, cursor: false }));
  localStorage.setItem("praxis.tools.defaults.v4", "4");
  const t = resolveToolOrNull("claude");
  ok(t === null, "all coding tools disabled → null (execute loop skips the step)");
  localStorage.clear();
}

// ══════════════════════════════════════════════════════════════════════════
// 6. Skill-capture loop pure logic (skills.ts)
// ══════════════════════════════════════════════════════════════════════════
console.log("\nskill name derivation (skillNameFromGoal)");
{
  ok(skillNameFromGoal("deploy the site to production") === "deploy site production", "drops stopwords, keeps first ~4 meaningful words");
}
{
  ok(skillNameFromGoal("build the catalyzed alpha feed ranking algorithm now") === "build catalyzed alpha feed", "caps at 4 meaningful words");
}
{
  // all-stopword goal → degrades to a trimmed raw slice, never ""
  const n = skillNameFromGoal("to the my of");
  ok(typeof n === "string" && n.length > 0, `all-stopword goal → non-empty fallback (got "${n}")`);
}

console.log("\ncapture eligibility (isCaptureEligible)");
{
  ok(isCaptureEligible({ done: true, steps: [{ ok: true }] }) === true, "done + a successful step → eligible");
}
{
  ok(isCaptureEligible({ done: false, steps: [{ ok: true }] }) === false, "not done → NOT eligible (handoff/started runs excluded)");
}
{
  ok(isCaptureEligible({ done: true, steps: [{ ok: false }, { ok: false }] }) === false, "done but every step failed → NOT eligible");
}
{
  ok(isCaptureEligible({ done: true, steps: [] }) === false, "done with no steps → NOT eligible");
}

console.log("\nskill derivation (deriveSkill)");
{
  const result = {
    steps: [
      { tool: "claude", model: "opus", prompt: "design it", ok: true },
      { tool: "codex", prompt: "grunt work", ok: false },
      { tool: "claude", prompt: "finish it", ok: true },
    ],
    summary: "shipped it",
  };
  const skill = deriveSkill("deploy the site", result, 1751446800000);
  ok(skill.name === "deploy site" && skill.goal === "deploy the site" && skill.ts === 1751446800000, "name/goal/ts set from inputs", JSON.stringify(skill));
  ok(skill.steps.length === 2 && skill.steps[0].model === "opus" && skill.steps[1].prompt === "finish it", "only SUCCESSFUL steps kept, reduced to {tool,model,prompt}", JSON.stringify(skill.steps));
  ok(skill.steps[1].model === undefined, "step without a model omits the model field");
}

console.log("\nskill resolution (resolveSkill)");
{
  const saved = [
    { name: "deploy site", goal: "deploy the site to prod", steps: [], summary: "", ts: 1 },
    { name: "build feed", goal: "build the catalyzed feed", steps: [], summary: "", ts: 2 },
  ];
  const m = resolveSkill("deploy routine", saved); // {deploy} ⊆ {deploy,site,...}
  ok(m !== null && m.name === "deploy site", 'spoken "deploy routine" ⊆ "deploy site" → matched (handle word stripped)', m ? m.name : "null");
}
{
  const saved = [{ name: "deploy site", goal: "deploy the site", steps: [], summary: "", ts: 1 }];
  const m = resolveSkill("polish the memory galaxy", saved); // no overlap
  ok(m === null, "unrelated spoken name → no match (null)");
}
{
  // bare/handle-only spoken name → null (guards "run"/"run my skill" with no real name)
  const saved = [{ name: "deploy site", goal: "deploy the site", steps: [], summary: "", ts: 1 }];
  ok(resolveSkill("skill", saved) === null, 'spoken "skill" (handle only) → null');
  ok(resolveSkill("", saved) === null, "empty spoken name → null");
}
{
  // token can match against the GOAL, not just the name
  const saved = [{ name: "morning", goal: "run the nightly backup and email report", steps: [], summary: "", ts: 1 }];
  const m = resolveSkill("backup report", saved); // {backup,report} ⊆ goal tokens
  ok(m !== null && m.name === "morning", "spoken tokens matched against goal (not just name)", m ? m.name : "null");
}
{
  // multiple matches → prefer higher name-token overlap; tie → newest ts
  const saved = [
    { name: "deploy site", goal: "deploy the site", steps: [], summary: "", ts: 1 },
    { name: "deploy api", goal: "deploy the api", steps: [], summary: "", ts: 5 },
  ];
  const m = resolveSkill("deploy", saved); // {deploy} ⊆ both names, equal overlap → newest ts wins
  ok(m !== null && m.name === "deploy api", "ambiguous match → newest (highest ts) wins", m ? `${m.name} ts=${m.ts}` : "null");
}

// ══════════════════════════════════════════════════════════════════════════
// 7. Per-delegation supervision loop (supervision.ts) - the Forge/Vega/Quill
//    "monitor and make sure it's done" evaluate-and-re-prompt loop.
// ══════════════════════════════════════════════════════════════════════════
console.log("\ndelegation-verdict parsing (parseDelegationVerdict)");
{
  const v = parseDelegationVerdict(JSON.stringify({ sufficient: true, feedback: "" }));
  ok(v !== null && v.sufficient === true && v.feedback === "", "sufficient:true verdict parsed");
}
{
  const v = parseDelegationVerdict(JSON.stringify({ sufficient: false, feedback: "tests missing" }));
  ok(v !== null && v.sufficient === false && v.feedback === "tests missing", "sufficient:false verdict keeps feedback");
}
{
  // Fenced JSON
  const v = parseDelegationVerdict("```json\n" + JSON.stringify({ sufficient: true, feedback: "ok" }) + "\n```");
  ok(v !== null && v.sufficient === true, "code-fenced delegation verdict → parsed after fence strip");
}
{
  // Missing boolean `sufficient` → null (caller fails open)
  ok(parseDelegationVerdict(JSON.stringify({ feedback: "x" })) === null, "verdict missing boolean `sufficient` → null");
}
{
  ok(parseDelegationVerdict("not json {{{") === null, "malformed delegation verdict JSON → null");
}

console.log("\nre-prompt text (repromptText) + eval prompt (evaluateDelegationPrompt)");
{
  const rp = repromptText("build the login form", "no validation on the email field", 1);
  ok(
    rp.includes("build the login form") && rp.includes("no validation on the email field") && rp.includes(`1/${SUPERVISION_MAX_REPROMPTS}`),
    "re-prompt embeds original task + feedback + attempt counter",
    rp,
  );
}
{
  const rp = repromptText("do X", "", 2);
  ok(rp.includes("do X") && rp.toLowerCase().includes("did not fully accomplish"), "empty feedback → generic fallback feedback line");
}
{
  const p = evaluateDelegationPrompt("ship the release", "I have shipped the release build.");
  ok(p.includes("ship the release") && p.includes("shipped the release build") && p.includes('"sufficient"'), "eval prompt carries task + output + JSON contract");
}
{
  // Live 2026-10-10: the brief was cut at 600 chars and the result at its first 1,400, so
  // the agent's closing report never reached the supervisor and finished work came back
  // twice as "unverified".
  const brief = "Build the sea otter page. " + "Requirement detail. ".repeat(120) + "FINAL-REQUIREMENT: fun facts link to #facts.";
  const result = "PRAXIS FILE CHECK: index.html 6.1 KB\n" + "agent log line\n".repeat(600) + "AGENT REPORT: all requirements met; #facts verified.";
  const p = evaluateDelegationPrompt(brief, result);
  ok(p.includes("FINAL-REQUIREMENT"), "the whole brief reaches the supervisor (briefs run 1-4K chars)");
  ok(p.includes("PRAXIS FILE CHECK") && p.includes("AGENT REPORT: all requirements met"), "the result's head (file check) AND tail (the agent's report) both reach it");
  ok(/cannot open files/i.test(p) && /real-browser look/i.test(p), "it is told what it can't see and that later checks exist, so it doesn't loop on unverifiable evidence");
}
{
  const { endedOnToolError } = supervision;
  ok(endedOnToolError([{ attempt: 0, sufficient: null, feedback: "tool error: codex exited 1" }]) === true, "a tool error ends the run on a tool error");
  ok(endedOnToolError([{ attempt: 0, sufficient: false, feedback: "x" }, { attempt: 2, sufficient: false, feedback: "evidence missing" }]) === false, "a rejected finished result is not a tool error");
  const { failureMessage } = loadOrchModule("./missionText");
  const msg = failureMessage({ summary: "", steps: [{ tool: "codex", ok: false, toolError: false, prompt: "p", output: "QA: GET /login returned 401 unauthorized as expected" }] });
  ok(!/not logged in/i.test(msg), "a rejected result that mentions 401 /login never reads as 'Codex CLI is not logged in'");
}

console.log("\nsupervision loop (superviseDelegation) — the async evaluate/re-prompt engine");
(async () => {
  // Helper: a mock runTool that returns queued outputs in order, recording prompts.
  const makeRunner = (outputs) => {
    const prompts = [];
    let i = 0;
    const run = async (prompt) => {
      prompts.push(prompt);
      const out = outputs[Math.min(i, outputs.length - 1)];
      i++;
      if (out instanceof Error) throw out;
      return out;
    };
    return { run, prompts };
  };
  // Helper: a mock evaluate that returns queued verdicts in order.
  const makeEval = (verdicts) => {
    let i = 0;
    return async () => {
      const v = verdicts[Math.min(i, verdicts.length - 1)];
      i++;
      return v;
    };
  };

  // ── Case A: first result is sufficient → accepted, 0 re-prompts ──────────
  {
    const r = makeRunner(["done cleanly"]);
    const out = await superviseDelegation("task A", true, {
      runTool: r.run,
      evaluate: makeEval([{ sufficient: true, feedback: "" }]),
    });
    ok(out.ok === true && out.reprompts === 0 && r.prompts.length === 1, "sufficient first result → ok, 0 re-prompts, tool run once", JSON.stringify({ ok: out.ok, reprompts: out.reprompts, runs: r.prompts.length }));
    ok(out.supervision.length === 1 && out.supervision[0].sufficient === true, "trail records the single accepting cycle");
  }

  // ── Case B: insufficient → re-prompt → success (the headline loop) ───────
  {
    const r = makeRunner(["half-done", "now complete"]);
    const events = [];
    const out = await superviseDelegation("task B", true, {
      runTool: r.run,
      evaluate: makeEval([
        { sufficient: false, feedback: "missing error handling" },
        { sufficient: true, feedback: "" },
      ]),
      onEvent: (e) => events.push(e.kind),
    });
    ok(out.ok === true && out.reprompts === 1, "insufficient→re-prompt→success → ok after exactly 1 re-prompt", JSON.stringify({ ok: out.ok, reprompts: out.reprompts }));
    ok(r.prompts.length === 2, "tool was run twice (initial + 1 re-prompt)", `runs=${r.prompts.length}`);
    ok(r.prompts[1].includes("task B") && r.prompts[1].includes("missing error handling"), "the re-prompt carried the original task + the concrete feedback", r.prompts[1]);
    ok(out.output === "now complete", "final output is the SUCCESSFUL re-prompt's output, not the first");
    ok(events.includes("reprompt") && events.includes("accepted"), "lifecycle events fired (reprompt + accepted) for roster visibility", JSON.stringify(events));
    ok(out.supervision.length === 2 && out.supervision[0].sufficient === false && out.supervision[1].sufficient === true, "trail records both cycles (insufficient then sufficient)");
  }

  // ── Case C: two-strike failure → never sufficient, exhausts budget, ok:false
  {
    const r = makeRunner(["nope1", "nope2", "nope3"]);
    const events = [];
    const out = await superviseDelegation("task C", true, {
      runTool: r.run,
      evaluate: makeEval([
        { sufficient: false, feedback: "still broken 1" },
        { sufficient: false, feedback: "still broken 2" },
        { sufficient: false, feedback: "still broken 3" },
      ]),
      onEvent: (e) => events.push(e.kind),
    });
    ok(out.ok === false && out.reprompts === SUPERVISION_MAX_REPROMPTS, "persistent insufficiency → ok:false after MAX re-prompts (two-strike)", JSON.stringify({ ok: out.ok, reprompts: out.reprompts }));
    ok(r.prompts.length === SUPERVISION_MAX_REPROMPTS + 1, "tool run exactly 1 + MAX times (bounded — no runaway loop)", `runs=${r.prompts.length}`);
    ok(out.output.includes("[supervision: FAILED") && out.output.includes("still broken 3"), "failed output carries the supervision failure marker + last feedback", out.output);
    ok(events.includes("exhausted"), "exhausted lifecycle event fired (roster shows escalation)");
    ok(out.supervision.length === SUPERVISION_MAX_REPROMPTS + 1 && out.supervision.every((c) => c.sufficient === false), "trail records all failed cycles for the ledger");
  }

  // ── Case D: supervise=false → single pass, no evaluation, ok:true ────────
  {
    const r = makeRunner(["raw output"]);
    let evalCalls = 0;
    const out = await superviseDelegation("task D", false, {
      runTool: r.run,
      evaluate: async () => { evalCalls++; return { sufficient: false, feedback: "x" }; },
    });
    ok(out.ok === true && out.reprompts === 0 && evalCalls === 0, "supervise=false → single pass, evaluate never called (Hermes-off contract)", JSON.stringify({ ok: out.ok, reprompts: out.reprompts, evalCalls }));
  }

  // ── Case E: evaluator unavailable (null verdict) → FAIL OPEN, accept ─────
  {
    const r = makeRunner(["got a result"]);
    const out = await superviseDelegation("task E", true, {
      runTool: r.run,
      evaluate: async () => null, // brain unreachable
    });
    ok(out.ok === true && out.reprompts === 0 && r.prompts.length === 1, "evaluator null (brain down) → fail-open accept, no re-prompt", JSON.stringify({ ok: out.ok, reprompts: out.reprompts }));
    ok(out.supervision.length === 1 && out.supervision[0].sufficient === null, "trail records the unavailable-evaluator cycle (sufficient:null)");
  }

  // Local disk evidence outranks an unavailable/incorrect evaluator. This is
  // the LIVE file-check seam: a claimed success with missing artifacts must
  // receive the normal SAME-tool corrective prompt before fail-open applies.
  {
    const r = makeRunner(["claimed success", "files now exist"]);
    let checks = 0;
    const out = await superviseDelegation("owned live build", true, {
      runTool: r.run,
      checkResult: async () => (++checks === 1
        ? { sufficient: false, feedback: "missing index.html" }
        : { sufficient: true, feedback: "" }),
      evaluate: async () => null,
    });
    ok(out.ok === true && out.reprompts === 1 && r.prompts.length === 2 && r.prompts[1].includes("missing index.html"),
      "local missing-file check forces a bounded same-tool retry even when evaluator is unavailable", JSON.stringify({ reprompts: out.reprompts, prompts: r.prompts }));
  }

  // ── Case F: tool throws → ok:false immediately, no re-prompt (can't critique a non-result)
  {
    const r = makeRunner([new Error("cursor-agent not installed")]);
    let evalCalls = 0;
    const out = await superviseDelegation("task F", true, {
      runTool: r.run,
      evaluate: async () => { evalCalls++; return { sufficient: true, feedback: "" }; },
    });
    ok(out.ok === false && out.reprompts === 0 && evalCalls === 0, "tool throw → ok:false, evaluate not called, no re-prompt", JSON.stringify({ ok: out.ok, reprompts: out.reprompts, evalCalls }));
    ok(out.output.includes("cursor-agent not installed"), "thrown error message is surfaced as the output");
    ok(out.supervision.length === 1 && out.supervision[0].sufficient === null && out.supervision[0].feedback.includes("tool error"), "trail records the tool-error cycle");
  }

  // ── Case G: insufficient once, then tool throws on re-prompt → ok:false ──
  {
    const r = makeRunner(["partial", new Error("spawn failed on retry")]);
    const out = await superviseDelegation("task G", true, {
      runTool: r.run,
      evaluate: makeEval([{ sufficient: false, feedback: "incomplete" }]),
    });
    ok(out.ok === false && out.reprompts === 1, "insufficient→re-prompt→throw → ok:false at re-prompt 1", JSON.stringify({ ok: out.ok, reprompts: out.reprompts }));
    ok(r.prompts.length === 2, "tool run twice then the throw stopped the loop");
  }

  // Case H: cancellation during a tool run blocks evaluator admission.
  {
    const controller = new AbortController();
    let toolCalls = 0;
    let evalCalls = 0;
    const out = await superviseDelegation("task H", true, {
      signal: controller.signal,
      runTool: async () => {
        toolCalls += 1;
        controller.abort();
        return "partial output";
      },
      evaluate: async () => {
        evalCalls += 1;
        return { sufficient: false, feedback: "should never run" };
      },
    });
    ok(out.ok === false && out.reprompts === 0, "owner cancellation during tool run fails closed without a re-prompt", JSON.stringify({ ok: out.ok, reprompts: out.reprompts }));
    ok(toolCalls === 1 && evalCalls === 0, "owner cancellation blocks every downstream evaluator admission", JSON.stringify({ toolCalls, evalCalls }));
    ok(out.output.includes("stopped by owner"), "owner cancellation is explicit in the supervised output");
  }

  // Case I: cancellation during evaluation blocks the corrective tool re-prompt.
  {
    const controller = new AbortController();
    let toolCalls = 0;
    let evalCalls = 0;
    const out = await superviseDelegation("task I", true, {
      signal: controller.signal,
      runTool: async () => {
        toolCalls += 1;
        return "incomplete";
      },
      evaluate: async () => {
        evalCalls += 1;
        controller.abort();
        return { sufficient: false, feedback: "retry requested too late" };
      },
    });
    ok(out.ok === false && out.reprompts === 0, "owner cancellation during evaluation fails closed before retry", JSON.stringify({ ok: out.ok, reprompts: out.reprompts }));
    ok(toolCalls === 1 && evalCalls === 1, "owner cancellation prevents the corrective tool admission", JSON.stringify({ toolCalls, evalCalls }));
  }

  {
    const parse = loadOrchModule("./parse");
    const { dispatchBrainDump } = orchestrator;

    // 1. Splitting + routing on the exact dump from the Cursor brief.
    const prompt =
      "ok so the flight deck still shows the wrong count, also I want the galaxy to stop spinning when I'm not looking at it, and can you look into why the earnings detector missed BABA last week, oh and remind me to email the venue about the deferral";
    const tasks = parse.splitBrainDump(prompt);
    ok(tasks.length === 4, "a four-ask brain dump yields four tasks, not one", JSON.stringify(tasks.map((t) => t.ask)));
    ok(
      tasks.map((t) => t.kind).join(",") === "build,build,investigate,note",
      "each ask gets the right kind (build, build, investigate, note)",
      tasks.map((t) => t.kind).join(","),
    );
    const earnings = tasks.find((t) => /earnings/i.test(t.text));
    ok(
      earnings && earnings.repo && earnings.repo.id === "earnings-print-detector",
      "the earnings detector routes to ITS OWN lane, not Catalyzed Alpha",
      JSON.stringify(earnings && earnings.repo),
    );

    // 2. The owner's own complaint-shaped dump: nothing dropped, and complaints are builds.
    const real =
      "Okay, so first of all the usage limits are random. Codex shows some number. Also I want a restore button in the control panel, and the flight deck should only show my two calendars. Actually can you check why forge keeps orbiting when it finished twelve hours ago";
    const realTasks = parse.splitBrainDump(real);
    const joined = realTasks.map((t) => t.text).join(" ");
    ok(
      ["usage limits", "Codex shows", "restore button", "calendars", "forge keeps orbiting"].every((w) => joined.includes(w)),
      "no piece of a real dump is silently dropped",
      JSON.stringify(realTasks.map((t) => t.text)),
    );
    const usage = realTasks.find((t) => /usage limits/.test(t.text));
    ok(usage && usage.kind === "build", "a complaint ('the usage limits are random') is a build, not unclassified", usage && usage.kind);
    const restore = realTasks.find((t) => /restore button/.test(t.text));
    ok(restore && restore.repo && restore.repo.id === "praxis", "Praxis UI words ('control panel') route to praxis", JSON.stringify(restore && restore.repo));
    const forge = realTasks.find((t) => /forge/.test(t.text));
    ok(forge && forge.repo && forge.repo.id === "praxis", "an agent name ('forge keeps orbiting') routes to praxis", JSON.stringify(forge && forge.repo));

    // 3. End-to-end dispatch with an injected runner: routable tasks run with the
    //    right folder, notes are filed, and every task reaches a terminal state.
    localStorage.clear();
    policy.invalidateAvailability(); // availability is cached 15s; each case must probe fresh
    const calls = [];
    const report = await dispatchBrainDump(prompt, {
      dumpId: "dump-test",
      concurrency: 1,
      folderExists: async () => true,
      // An AvailabilityProbe is an object of probe METHODS. Empty means "no live
      // signal", so routing falls back to the breakers - all on by default.
      availabilityProbe: {},
      runTask: async (goal, opts) => {
        calls.push({ goal, cwd: opts.cwd, tool: opts.preferredTool });
        return { done: true, summary: "ok", steps: [{ tool: opts.preferredTool || "claude", ok: true }] };
      },
    });
    ok(report.tasks.length === 4 && report.runs.length === 4, "every task gets exactly one ledger row", JSON.stringify({ tasks: report.tasks.length, runs: report.runs.length }));
    ok(report.noted === 1, "the remind-me is filed as a note, not dispatched", JSON.stringify({ noted: report.noted }));
    const terminal = report.runs.every((r) => ["done", "failed", "stopped", "queued", "noted", "unclassified"].includes(r.state));
    ok(terminal, "dispatch resolves only when every run is terminal", JSON.stringify(report.runs.map((r) => r.state)));
    ok(
      !calls.some((c) => /remind me/i.test(c.goal)),
      "a note never reaches an agent",
      JSON.stringify(calls.map((c) => c.goal.slice(0, 40))),
    );
    const earningsCall = calls.find((c) => /earnings/i.test(c.goal));
    ok(
      !earningsCall || (earningsCall.cwd || "").includes("earnings-print-detector"),
      "a dispatched investigation runs in the folder its repo implies",
      JSON.stringify(earningsCall && earningsCall.cwd),
    );
    ok(typeof report.summary === "string" && report.summary.length > 0, "the dump always reports what happened", JSON.stringify(report.summary));

    // 4. When nothing can run, it says so instead of producing nothing.
    // Every coding breaker OFF. The defaults-version key must be current, or the
    // one-time v7 migration would (correctly) turn them back on.
    localStorage.clear();
    localStorage.setItem("praxis.tools.defaults.v7", "7");
    localStorage.setItem(
      "praxis.tools.v1",
      JSON.stringify({ claude: false, codex: false, cursor: false, openrouter: false, hermes: true, "computer-use": true }),
    );
    policy.invalidateAvailability();
    const dark = await dispatchBrainDump("fix the flight deck count", {
      dumpId: "dump-dark",
      folderExists: async () => true,
      availabilityProbe: {},
      runTask: async () => {
        throw new Error("must not run when every rail is dark");
      },
    });
    ok(dark.dispatched === 0, "no rail available → nothing is dispatched", JSON.stringify({ dispatched: dark.dispatched }));
    ok(
      dark.runs.length === 1 && dark.runs[0].state === "queued" && !!dark.runs[0].reason,
      "an unroutable task is QUEUED with the reason, not dropped",
      JSON.stringify(dark.runs[0]),
    );
    localStorage.clear();
    policy.invalidateAvailability();
  }

  // ── A BRAIN DUMP FANS OUT WHEREVER IT IS SAID ────────────────────────────────
  // Before this, only the D box split a dump. The same four asks spoken to Atlas or
  // typed into Mission went to ONE agent run as one paragraph.
  {
    const parse = loadOrchModule("./parse");

    // 1. One definition of "this is a dump", with the context-keeping cases pinned.
    const table = [
      [true, "ok so the flight deck still shows the wrong count, also I want the galaxy to stop spinning when I'm not looking at it, and can you look into why the earnings detector missed BABA last week, oh and remind me to email the venue about the deferral", "four asks with spoken connectors"],
      [true, "Fix the flight deck count. Stop the galaxy spinning. Look into BABA.", "three sentences that each lead with an instruction"],
      [true, "fix the flight deck count\nremind me to email the advisor", "a typed list"],
      [false, "Fix the deck. The count is wrong when sessions archive.", "an ask plus the detail an agent needs stays ONE ask"],
      [false, "Fix the deck, the count is wrong when sessions archive", "the comma form of ask-plus-detail stays ONE ask"],
      [false, "hey how are you doing, I want to know what you think", "chatter with one incidental request is not a dump"],
      [false, "open Chrome and type hello", "a bare 'and' desktop sequence is not a dump"],
      [false, "build the landing page and make it look good", "one build with a qualifier is not a dump"],
      [false, "make the deck also show codex sessions", "'also' inside one ask is not a new ask"],
    ];
    for (const [want, text, label] of table) {
      const got = parse.isMultiAskDump(text);
      ok(got === want, `isMultiAskDump: ${label}`, JSON.stringify({ want, got }));
    }

    // 2. The dump report reads as NOT done while anything is left undone.
    const asResult = orchestrator.brainDumpAsOrchResult;
    const rep = (states) => ({ summary: "s", runs: states.map((state) => ({ state })) });
    ok(asResult(rep(["done", "noted"])).done === true, "a dump is done when every run is done or filed");
    ok(asResult(rep(["done", "queued"])).done === false, "one queued task means the dump is NOT done");
    ok(asResult(rep(["done", "unclassified"])).done === false, "one unclassified task means the dump is NOT done");
    ok(asResult(rep([])).done === false, "an empty dump never claims done");
    ok(asResult(rep(["done"])).summary === "s", "the dump's own summary is what gets spoken");

    // 3. Voice: tryOrchestrate reaches the dispatcher even when every ask is a
    //    complaint that BUILD_RE's imperative verbs would never match. Every coding
    //    breaker is off, so each task queues with its reason and nothing runs.
    localStorage.clear();
    localStorage.setItem("praxis.tools.defaults.v7", "7");
    localStorage.setItem(
      "praxis.tools.v1",
      JSON.stringify({ claude: false, codex: false, cursor: false, openrouter: false, hermes: true, "computer-use": true }),
    );
    policy.invalidateAvailability();
    const complaints = "the usage limits are random, also the flight deck is stale, and can you check why forge keeps orbiting";
    ok(responder.isBuildIntent(complaints) === false, "(precondition) the old imperative gate alone would have ignored this dump");
    const voiceRun = responder.tryOrchestrate(complaints, { availabilityProbe: {} });
    ok(voiceRun !== null, "a spoken complaint dump reaches orchestration instead of falling through");
    const voiceResult = voiceRun ? await voiceRun : null;
    ok(
      voiceResult && voiceResult.done === false && typeof voiceResult.summary === "string" && voiceResult.summary.length > 0,
      "the voice reply for a dump that could not run says so, and never claims done",
      JSON.stringify(voiceResult),
    );
    ok(responder.tryOrchestrate("hey how are you doing, I want to know what you think", {}) === null,
      "chatter does not start any run");
    localStorage.clear();
    policy.invalidateAvailability();

    // 4. Mission input: a dump becomes one goal per real ask; a single ask keeps
    //    its detail together.
    const submit = loadOrchModule("./submitClassify");
    for (const [phrase, intent] of require("./voice-operation-cases.cjs")) {
      const typed = submit.classifySubmit(phrase, []);
      ok(typed.commands.length === 1 && typed.commands[0].intent.kind === intent.kind &&
        typed.goals.length === 0 && typed.questions.length === 0 && typed.sovereignGoals.length === 0 && !typed.fileText,
        `Mission: ${phrase} routes exclusively to ${intent.kind}`, JSON.stringify(typed));
    }
    const assignment = submit.classifySubmit("build a landing page; use Opus 5.5 for Forge", []);
    ok(assignment.goals.length === 1 && assignment.commands[0]?.intent.kind === "fleet-model",
      "Mission: an explicit model assignment after a goal remains a command", JSON.stringify(assignment));
    const four = "ok so the flight deck still shows the wrong count, also I want the galaxy to stop spinning when I'm not looking at it, and can you look into why the earnings detector missed BABA last week, oh and remind me to email the venue about the deferral";
    const plan = submit.classifySubmit(four, []);
    ok(plan.goals.length === 3, "Mission: a four-ask dump yields three goals (build, build, investigate)", JSON.stringify(plan.goals));
    ok(/remind me to email/i.test(plan.fileText), "Mission: the remind-me is filed, not run", JSON.stringify(plan.fileText));
    ok(!plan.goals.some((g) => /remind me/i.test(g)), "Mission: a note never becomes a goal", JSON.stringify(plan.goals));
    // A control command inside a dump still runs as a command, never as a coding task.
    const halted = submit.classifySubmit("stop everything, also fix the flight deck count", []);
    ok(
      halted.commands.some((c) => c.intent.kind === "halt") && !halted.goals.some((g) => /stop everything/i.test(g)),
      "Mission: HALT inside a dump is still a command, not a goal handed to an agent",
      JSON.stringify({ commands: halted.commands.map((c) => c.intent.kind), goals: halted.goals }),
    );
    ok(halted.goals.length === 1 && /flight deck count/.test(halted.goals[0]), "Mission: the rest of that dump still runs", JSON.stringify(halted.goals));
    // A bare "stop" classified identically before and after (not a dump, not a goal).
    const bare = submit.classifySubmit("stop", []);
    ok(bare.goals.length === 0 && bare.sovereignGoals.length === 0, "Mission: a bare 'stop' never becomes work", JSON.stringify(bare));

    const detail = "Fix the deck. The count is wrong when sessions archive.";
    const single = submit.classifySubmit(detail, []);
    ok(
      single.goals.length === 1 && single.goals[0].includes("wrong when sessions archive"),
      "Mission: one ask with its detail stays ONE goal carrying that detail",
      JSON.stringify(single.goals),
    );
  }

  // ── Coverage the brain-dump packet required and did not get ───────────────────
  {
    // Unclassified pieces are kept, asked about, and never handed to an agent.
    localStorage.clear();
    policy.invalidateAvailability();
    const seen = [];
    const mixed = await orchestrator.dispatchBrainDump("fix the flight deck count, also the weather in paris", {
      dumpId: "dump-unclassified",
      concurrency: 1,
      folderExists: async () => true,
      availabilityProbe: {},
      runTask: async (goal, opts) => {
        seen.push(goal);
        return { done: true, summary: "ok", steps: [{ tool: opts.preferredTool || "claude", ok: true }] };
      },
    });
    const odd = mixed.runs.find((r) => /weather/i.test(r.text));
    ok(odd && odd.state === "unclassified", "a piece with no cue is kept as unclassified, not dropped", JSON.stringify(odd));
    ok(odd && /build, an investigation or a note/.test(odd.reason || ""), "an unclassified piece says exactly what to tell it", JSON.stringify(odd && odd.reason));
    ok(!seen.some((g) => /weather/i.test(g)), "an unclassified piece never reaches an agent", JSON.stringify(seen));
    ok(mixed.unclassified === 1, "the report counts it", JSON.stringify({ unclassified: mixed.unclassified }));

    // The sentences a queued task shows, one per real failure shape.
    const noon = new Date(2026, 8, 12, 12, 0, 0).getTime();
    const cf = drivers.classifyToolFailure;
    const signedOut = cf("claude", "Not logged in · Please run /login", noon);
    ok(signedOut && /\/login/.test(signedOut.reason), "a signed-out Claude CLI names /login", JSON.stringify(signedOut));
    const noCursor = cf("cursor", "cursor-agent not found or failed to spawn", noon);
    ok(noCursor && /irm .*cursor\.com\/install/.test(noCursor.reason), "a missing cursor-agent names the install command", JSON.stringify(noCursor));
    // Live 2026-09-16: Forge exited 1 with this in its JSON result; unrecognised, the next
    // Claude step was sent into the same exhausted window.
    const outClaude = cf(
      "claude",
      'claude exited Some(1): {"type":"result","is_error":true,"result":"You\'ve hit your session limit · resets 9pm (America/New_York)"}',
      noon,
    );
    ok(outClaude && /out of usage until/.test(outClaude.reason) && typeof outClaude.retryAt === "number" && outClaude.retryAt > noon,
      "a Claude Pro SESSION limit is remembered until its reset (\"resets 9pm\" has no 'at')", JSON.stringify(outClaude));
    const outCodex = cf("codex", "You've hit your usage limit. Try again at 2:02 PM.", noon);
    ok(outCodex && /out of usage until/.test(outCodex.reason) && typeof outCodex.retryAt === "number" && outCodex.retryAt > noon,
      "an exhausted Codex names when it comes back", JSON.stringify(outCodex));
    ok(cf("codex", "connection reset by peer", noon) === null, "a transient error is not remembered as a dead rail");
    ok(cf("codex", "request timed out", noon) === null, "a slow Codex task is not mistaken for a dead rail");
    ok(cf("claude", "Claude CLI didn't answer within 55s", noon) !== null, "a silent Claude CLI IS remembered (it will not answer the next caller either)");

    const cue = policy.codexUsageExhaustion;
    const later = noon + 2 * 3600 * 1000;
    const row = (plan) => [{ key: "codex", plan }];
    const hot = cue(row([{ window: "5h", used: 99, limit: 100, basis: "real", resets_at: later }]), noon);
    ok(hot && /5h usage until/.test(hot.reason) && hot.retryAt === later, "a real 99% 5h window names the reset", JSON.stringify(hot));
    ok(cue(row([{ window: "5h", used: 100, limit: 100, basis: "estimated", resets_at: later }]), noon) === null,
      "an ESTIMATE can never declare Codex out of usage");
    ok(cue(row([{ window: "weekly", used: 50, limit: 100, basis: "real", resets_at: later }]), noon) === null,
      "half a window is not exhausted");
    const lapsed = cue(row([{ window: "5h", used: 100, limit: 100, basis: "real", resets_at: noon - 60000 }]), noon);
    ok(lapsed && !/until/.test(lapsed.reason) && lapsed.retryAt === undefined,
      "a full window with an elapsed reset does not invent a future time", JSON.stringify(lapsed));
    localStorage.clear();
    policy.invalidateAvailability();
  }

  // ── THE ACCEPTANCE CHAIN (2026-09-16) ──────────────────────────────────────
  // The owner's sentence, end to end through the REAL orchestrate() with a fake Tauri
  // backend: team named → every member works, new project → own workspace (never
  // the Praxis repo), real memory → brief with source files, file gate → done only
  // when index.html is real, delivery → opened AND maximized by page title, ledger
  // → records the memory it used.
  {
    const SENTENCE =
      "Create a personal website — you choose the content, you have memory — using Vega, Quill and Forge. Then open it in a browser and maximize it on my screen.";
    const bc = loadOrchModule("./buildChain");

    // Pure pieces
    ok(JSON.stringify(bc.namedTeam(SENTENCE)) === JSON.stringify(["codex", "cursor", "claude"]),
      "chain: Vega, Quill, Forge → codex, cursor, claude in spoken order", JSON.stringify(bc.namedTeam(SENTENCE)));
    ok(bc.namedTeam("move the cursor to the top of the page").length === 0, "chain: 'the cursor' is not Quill");
    ok(JSON.stringify(bc.namedTeam("fix the bug using claude and codex")) === JSON.stringify(["claude", "codex"]),
      "chain: product names count after a delegation cue");
    ok(bc.isNewProjectGoal(SENTENCE) === true, "chain: the sentence is a NEW project");
    ok(bc.repoFolderFor(SENTENCE) === undefined, "chain: team names are not a Praxis repo hint");
    ok(bc.isNewProjectGoal("create a new landing page for catalyzed alpha") === false, "chain: a named repo is not a new project");
    ok(bc.projectSlug(SENTENCE) === "personal-website", "chain: slug", bc.projectSlug(SENTENCE));
    ok(JSON.stringify(bc.parseDelivery(SENTENCE)) === JSON.stringify({ open: true, maximize: true }), "chain: open + maximize parsed");
    ok(bc.parseDelivery("create a personal website") === null, "chain: no delivery when none was asked");
    ok(bc.parseDelivery("build an app that can open files") === null, "chain: 'open files' inside the spec is not a delivery");
    const q = bc.memoryQuery(SENTENCE);
    ok(/personal website/i.test(q) && !/vega|browser|maximi/i.test(q), "chain: memory query is the subject, not the team or delivery", q);
    ok(bc.wantsProfile(SENTENCE) === true, "chain: a personal site leads with who Zach is");
    ok(bc.sanitizeStepModel("cursor", "gpt-6-astra-medium") === "grok-4.7-high", "chain: a non-Cursor id becomes Grok 4.7, not the CLI default");
    for (const apiPool of ["auto", "claude-opus-5-high", "claude-opus-5-5-high", "claude-sonnet-5-thinking-high", "gpt-5.6-sol-high", "composer-2.5-fast", "cursor-grok-4.6-high-fast", "grok-4.7-high-fast"]) {
      ok(bc.sanitizeStepModel("cursor", apiPool) === "grok-4.7-high", `chain: Quill never runs ${apiPool} (API pool or 2-6x fast pricing)`);
    }
    ok(bc.sanitizeStepModel("cursor", "composer-2.5") === "composer-2.5", "chain: Composer 2.5 is Quill's simple-work model");
    // Owner request 2026-09-17: switch a breaker off and Praxis delegates to what it has available.
    {
      const all = bc.availableTeam(["codex", "cursor", "claude"], () => true);
      ok(JSON.stringify(all.team) === '["codex","cursor","claude"]' && all.note === "", "team: everyone available, nobody benched");
      const off = bc.availableTeam(["codex", "cursor", "claude"], (t) => t !== "cursor");
      ok(JSON.stringify(off.team) === '["codex","claude"]', "team: Quill's breaker off → Vega + Forge", JSON.stringify(off.team));
      ok(off.benched[0].tool === "cursor" && off.benched[0].standIn === "claude", "team: Forge stands in for Quill");
      ok(/Quill is switched off right now, so Quill sat this one out\. Forge took Quill's part\./.test(off.note), "team: the swap is said out loud", off.note);
      const pool = bc.availableTeam(["codex", "cursor", "claude"], () => true, { cursor: "Quill sat this one out: Cursor's own-model allowance is used up until Oct 2." });
      ok(pool.note.startsWith("Quill sat this one out: Cursor's own-model") && /Forge took Quill's part/.test(pool.note), "team: a paused rail keeps its own reason", pool.note);
      const refused = bc.availableTeam(["codex", "cursor", "claude"], () => true, { claude: "The vendor is refusing Claude Code since 1:32 PM, so Forge can't run" });
      ok(refused.note === "The vendor is refusing Claude Code since 1:32 PM, so Forge can't run. Vega took Forge's part.",
        "team: a reason that already says Forge can't run is not repeated", refused.note);
      const two = bc.availableTeam(["claude", "cursor"], (t) => t === "codex");
      ok(JSON.stringify(two.team) === '["codex"]' && two.benched.every((b) => b.standIn === "codex"), "team: Vega covers both when Forge and Quill are off", JSON.stringify(two));
      const none = bc.availableTeam(["cursor"], () => false);
      ok(none.team.length === 0 && /Nobody was available/.test(none.note), "team: nobody available is said plainly", none.note);
      ok(bc.standInModel("claude") === "claude-sonnet-5-5" && bc.standInModel("codex") === "gpt-6-astra" && bc.standInModel("cursor") === "grok-4.7-high", "team: stand-ins run their own default model");
    }
    ok(/composer-2\.5/.test(bc.TEAM_MODEL_GUIDE) && /never the API pool/.test(bc.TEAM_MODEL_GUIDE), "chain: the planner is told the Cursor pool rule");
    ok(bc.sanitizeStepModel("cursor", "cursor-grok-4.6-high") === "cursor-grok-4.6-high", "chain: Grok 4.6 is a Cursor id");
    ok(bc.sanitizeStepModel("cursor", "grok-4.7-xhigh") === "grok-4.7-xhigh", "chain: Grok 4.7 (Cursor Models pool) is a Cursor id");
    ok(bc.sanitizeStepModel("codex", "opus") === undefined && bc.sanitizeStepModel("codex", "gpt-6-astra") === "gpt-6-astra",
      "chain: codex pins must be OpenAI ids");
    const teamPlan = bc.defaultTeamPlan(["codex", "cursor", "claude"]);
    ok(JSON.stringify(teamPlan.map((s) => s.tool)) === JSON.stringify(["claude", "codex", "cursor", "claude"]),
      "chain: default division of labor = content, build, polish, review", JSON.stringify(teamPlan.map((s) => s.tool)));
    const covered = bc.ensureTeamCoverage([{ tool: "codex", prompt: "build it", why: "b" }], ["codex", "cursor", "claude"]);
    ok(["codex", "cursor", "claude"].every((t) => covered.some((s) => s.tool === t)) && covered[covered.length - 1].tool === "claude",
      "chain: a plan that skipped Quill and Forge gets both, Forge reviewing last", JSON.stringify(covered.map((s) => s.tool)));
    const crowded = bc.ensureTeamCoverage(
      [1, 2, 3, 4, 5].map((i) => ({ tool: "codex", prompt: `p${i}`, why: "" })),
      ["codex", "cursor", "claude"],
    );
    ok(crowded.length <= 5 && ["codex", "cursor", "claude"].every((t) => crowded.some((s) => s.tool === t)),
      "chain: coverage never exceeds 5 steps and never drops a named member", JSON.stringify(crowded.map((s) => s.tool)));
    const entry = (over) => ({ rel: "index.html", abs: "C:\\w\\index.html", bytes: 9000, title: "Zach", head: "<title>Zach</title>", ...over });
    const man = (e) => ({ root: "C:\\w", files: e ? [{ rel: "index.html", bytes: e.bytes }] : [], total_bytes: e ? e.bytes : 0, entry: e });
    ok(bc.deliverableGate(null).ok === false && bc.deliverableGate(man(null)).ok === false, "chain gate: no workspace / no entry fails");
    ok(bc.deliverableGate(man(entry({ bytes: 300 }))).ok === false, "chain gate: a stub page fails");
    const tinyHello = '<!doctype html><html><head><title>Hello</title></head><body><main><h1>Hello</h1></main></body></html>';
    ok(bc.deliverableGate(man(entry({ bytes: tinyHello.length, title: "Hello", head: tinyHello })), { allowMinimal: true }).ok === true &&
        bc.deliverableGate(man(entry({ bytes: tinyHello.length, title: "Hello", head: tinyHello }))).ok === false,
      "chain gate: explicit tiny hello proof passes only with complete static document structure", tinyHello);
    ok(bc.deliverableGate(man(entry({ bytes: 80, title: "Hello", head: "<!doctype html><html><head><title>Hello</title></head>" })), { allowMinimal: true }).ok === false,
      "chain gate: a tiny incomplete document still fails the minimal-proof exception");
    ok(bc.deliverableGate(man(entry({ bytes: 110, title: "Hello", head: '<!doctype html><html><head><title>Hello</title></head><body><!-- hello --></body></html>' })), { allowMinimal: true }).ok === false,
      "chain gate: a title and comment do not count as visible tiny-page body content");
    ok(bc.deliverableGate(man(entry({ title: null }))).ok === false, "chain gate: an untitled page fails");
    ok(bc.deliverableGate(man(entry({ head: "<title>x</title> Lorem ipsum dolor" }))).ok === false, "chain gate: placeholder text fails");
    ok(bc.deliverableGate(man(entry({}))).ok === true, "chain gate: a real titled page passes");
    ok(bc.manifestChanged(man(entry({ bytes: 9000 })), man(entry({ bytes: 9500 }))) === true && bc.manifestChanged(man(entry({})), man(entry({}))) === false && bc.manifestChanged(null, man(null)) === false,
      "chain: progress means files on disk changed during the pass");
    ok(bc.isDeliveryOnlyStep("Open the website in a visible browser, start a local server if needed, and maximize the window.") === true &&
        bc.isDeliveryOnlyStep("Fix the nav overlap at 360px, then open it in a browser to check.") === false &&
        bc.isDeliveryOnlyStep("Review the accessibility of the forms") === false,
      "chain: a step that only opens/serves/maximizes is delivery, not unfinished work (live run 4 looped on it)");
    ok(bc.wantsFreshBuild("create a personal website from scratch") && bc.wantsFreshBuild("make another landing page") && !bc.wantsFreshBuild("Create a personal website"),
      "chain: only an explicit 'from scratch'/'another' skips resuming");
    const rp = bc.resumeTeamPlan(["codex", "cursor", "claude"]);
    ok(rp[0].tool === "claude" && /UNFINISHED build/.test(rp[0].prompt) && ["codex", "cursor"].every((t) => rp.some((x) => x.tool === t)) && rp.every((x) => !/CONTENT.md: the site's structure/.test(x.prompt)),
      "chain: a resumed build's fallback plan reviews and finishes, it never rewrites the content", JSON.stringify(rp.map((x) => x.tool)));
    const viteShell = '<!doctype html><html><head><title>Zach</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>';
    ok(bc.deliverableGate(man(entry({ head: viteShell, bytes: 9000 }))).ok === false,
      "chain gate: a framework shell (blank from file://) fails — live 2026-09-16 the planner asked Vega for Vite/React");
    ok(bc.deliverableGate(man(entry({ head: '<title>Zach</title><link rel="stylesheet" href="/assets/app.css">' }))).ok === false,
      "chain gate: root-absolute asset paths fail (they resolve to C:\ from disk)");
    ok(bc.deliverableGate(man(entry({ head: '<title>Zach</title><link rel="stylesheet" href="styles.css"><script src="script.js" defer></script>' }))).ok === true,
      "chain gate: relative static assets pass");
    ok(/NON-NEGOTIABLE/.test(bc.teamStepPrompt({ tool: "codex", prompt: "Build it with Vite and React", why: "" }, "C:\w", null, true)),
      "chain: every web-build agent prompt carries the static-site rule AFTER its part, so a plan step cannot override it");

    // deliverResult: opens, keeps looking for the window, maximizes it by title.
    {
      const seen = [];
      let misses = 2;
      const res = await bc.deliverResult(entry({ title: "Zach Adams — Builder" }), { open: true, maximize: true },
        async (cmd, args) => {
          seen.push([cmd, args]);
          if (cmd === "desktop_window_control" && misses-- > 0) throw new Error('No open window matches "zach adams"');
          return "ok";
        }, async () => {});
      ok(res.opened && res.maximized && seen[0][0] === "desktop_open_url" && seen[0][1].url === "C:\\w\\index.html",
        "chain delivery: opens the entry file, then maximizes once the window appears", JSON.stringify(res));
      ok(seen.filter(([c]) => c === "desktop_window_control").every(([, a]) => a.action === "maximize" && a.target === "Zach Adams — Builder"),
        "chain delivery: the window is found by the PAGE TITLE, never 'whatever is in front'");
      const failed = await bc.deliverResult(entry({}), { open: true, maximize: true }, async () => { throw new Error("no browser"); }, async () => {});
      ok(failed.opened === false && failed.maximized === false, "chain delivery: an open failure is reported, not assumed");
    }

    // Typed brain-dump box: the sentence stays ONE goal with every clause attached.
    const submitMod = loadOrchModule("./submitClassify");
    const typed = submitMod.classifySubmit(SENTENCE, []);
    ok(typed.goals.length === 1 && /Vega, Quill and Forge/.test(typed.goals[0]) && /maximize/.test(typed.goals[0]) && /memory/.test(typed.goals[0]),
      "chain: the typed box keeps memory, team and delivery attached to the goal", JSON.stringify(typed.goals));
    const thenMax = submitMod.classifySubmit("create a landing page for the recital — then maximize it", []);
    ok(thenMax.goals.length === 1 && /then maximize it/.test(thenMax.goals[0]) && thenMax.commands.length === 0,
      "chain: 'then maximize it' waits for the goal instead of maximizing whatever is on screen now", JSON.stringify(thenMax));
    const sep = submitMod.classifySubmit("create the onboarding flow — tile the windows", []);
    ok(sep.goals.length === 1 && sep.goals[0] === "create the onboarding flow" && sep.commands.length === 1,
      "chain: an independent command after a goal still runs as a command", JSON.stringify(sep));

    // End to end through orchestrate() with a fake backend.
    const runChain = async ({ writesFiles, maxIterations, onDelegate, delegateThrows, existingFiles, goal, verifyReply, planReply, signal, failTools, teachDelayMs, live, liveWritesFiles, cwd, cursorError, cursorPool, intent, supervisionReplies, autonomy, usageRows, verifyReplies }) => {
      // Each chain run starts with no remembered rail failures (an earlier case's
      // timed-out Claude would otherwise reroute Forge for the rest of the file).
      drivers.forgetAllToolFailures();
      localStorage.clear();
      localStorage.setItem("praxis.tools.defaults.v7", "7");
      localStorage.setItem(
        "praxis.tools.v1",
        JSON.stringify({ claude: true, codex: true, cursor: true, openrouter: false, hermes: true, "computer-use": true }),
      );
      if (live) localStorage.setItem("praxis.execmode.v1", "live");
      if (autonomy) localStorage.setItem("praxis.autonomy", autonomy);
      policy.invalidateAvailability();
      const WS = "C:\\Users\\dev\\praxis-builds\\personal-website-2026-09-16";
      const MEM = "C:\\Users\\dev\\.claude\\projects\\C--Users-dev\\memory\\user-zach.md";
      const calls = [];
      missionEvents.length = 0;
      let files = existingFiles ? [...existingFiles] : [];
      let ledger = null;
      const liveCallsByTool = new Map();
      global.__praxisFakeInvoke = async (cmd, args) => {
        calls.push({ cmd, args });
        switch (cmd) {
          case "cursor_pool_state": return cursorPool ?? null;
          case "usage_summary": return usageRows ?? null;
          case "memory_recall":
            return [{ path: MEM, label: "Who Zach is", project: "C--Users-dev", kind: "note", memory_type: "user",
              description: "Mathematics and Engineering at Queen's; product-led builder", excerpt: "Builds Praxis, an AI operating system.", galaxy_id: "C--Users-dev:user-zach", score: 4 }];
          case "workspace_prepare":
            return WS;
          case "workspace_write_file":
            return `${args.root}\\${args.rel}`;
          case "hermes_brain": {
            const g = String(args.goal);
            if (g.includes("delegation supervisor")) return (supervisionReplies && supervisionReplies.shift()) || '{"sufficient":true,"feedback":""}';
            if (g.includes("verifying your own delegated work")) return (verifyReplies && verifyReplies.shift()) || verifyReply || '{"done":true,"reason":"site complete","steps":[],"summary":"site built"}';
            if (planReply) return planReply;
            return JSON.stringify({ steps: [
              { tool: "codex", model: "gpt-6-astra", prompt: "Build index.html, styles.css and script.js", why: "build" },
              { tool: "cursor", model: "gpt-6-astra-medium", prompt: "Polish responsive layout", why: "polish" },
            ], summary: "Zach's personal site" });
          }
          case "agent_delegate":
            if (onDelegate) onDelegate(args);
            if (cursorError && args.tool === "cursor") throw new Error(cursorError);
            if (writesFiles) files = [{ rel: "index.html", bytes: 9100 + calls.length }, { rel: "styles.css", bytes: 6200 }];
            if (delegateThrows || (failTools && failTools.includes(args.tool))) throw new Error(`agent_delegate(${args.tool}) timed out after 1800s`);
            return `${args.tool} finished`;
          case "live_operate_step": {
            const n = (liveCallsByTool.get(args.agent) || 0) + 1;
            liveCallsByTool.set(args.agent, n);
            // First owned build reply can claim success without files; the
            // second same-chat follow-up is the mocked repair that writes them.
            if (liveWritesFiles && args.agent === "codex" && n >= 2) {
              files = [
                { rel: "index.html", bytes: 9100 },
                { rel: "styles.css", bytes: 6200 },
                { rel: "script.js", bytes: 900 },
              ];
            }
            return JSON.stringify({ agent: args.agent, owned_session: true, follow_up: !!args.followUp, evidence: ["mock transcript advanced"], result: "owned reply" });
          }
          case "hermes_teach":
            await new Promise((r) => setTimeout(r, teachDelayMs || 0));
            return "taught";
          case "workspace_manifest":
            return files.length
              ? { root: args.root, files, total_bytes: 15300, entry: { rel: "index.html", abs: `${args.root}\\index.html`, bytes: 9100, title: "Zach Adams — Builder", head: "<!doctype html><title>Zach Adams — Builder</title>" } }
              : { root: args.root, files: [], total_bytes: 0, entry: null };
          case "desktop_open_url":
            return "Opened.";
          case "desktop_window_control":
            return "Maximized Zach Adams — Builder.";
          case "ledger_log_run":
            ledger = args.entry;
            return null;
          default:
            return null;
        }
      };
      const hadWindow = Object.prototype.hasOwnProperty.call(global, "window");
      const prevWindow = global.window;
      global.window = { __TAURI_INTERNALS__: {} };
      try {
        const orch = loadOrchModule("./orchestrator");
        const startedAt = Date.now();
        const result = await orch.orchestrate(goal || SENTENCE, {
          maxIterations,
          signal,
          cwd,
          intent,
          availabilityProbe: {
            planUsage: async () => [],
            pathExists: async () => true,
            dirs: async () => ({ home: "C:\\Users\\dev", localData: "C:\\Users\\dev\\AppData\\Local", data: "C:\\Users\\dev\\AppData\\Roaming" }),
          },
        });
        return { result, calls, ledger, WS, MEM, events: [...missionEvents], elapsedMs: Date.now() - startedAt };
      } finally {
        delete global.__praxisFakeInvoke;
        if (hadWindow) global.window = prevWindow;
        else delete global.window;
        localStorage.clear();
        policy.invalidateAvailability();
      }
    };

    // LIVE is an owned-chat contract. A manifest says the first Vega reply made
    // no files, even though Hermes accepts it; the deterministic check must
    // re-prompt the SAME registered chat. A second orchestration gets a new key.
    const LIVE_PLAN = JSON.stringify({ steps: [
      { tool: "codex", model: "gpt-6-astra", prompt: "Build the static entry", expectedFiles: ["index.html", "styles.css", "script.js"], why: "build" },
    ], summary: "owned live build" });
    const liveOne = await runChain({ live: true, liveWritesFiles: true, maxIterations: 2, planReply: LIVE_PLAN });
    const liveVega = liveOne.calls.filter((c) => c.cmd === "live_operate_step" && c.args.agent === "codex");
    ok(liveVega.length === 2 && liveVega[0].args.followUp === false && liveVega[1].args.followUp === true &&
        liveVega[0].args.sessionKey === liveVega[1].args.sessionKey,
      "LIVE e2e: missing exact artifacts force one bounded same-chat Vega retry even when Hermes accepts", JSON.stringify(liveVega.map((c) => c.args)));
    ok(!liveOne.calls.some((c) => c.cmd === "agent_delegate") && !liveOne.calls.some((c) => c.cmd === "live_operate_step" && c.args.agent === "cursor"),
      "LIVE e2e: owned path never falls back to headless and Quill stays off", JSON.stringify(liveOne.calls.filter((c) => /delegate|operate/.test(c.cmd))));
    const liveTwo = await runChain({ live: true, liveWritesFiles: true, maxIterations: 2, planReply: LIVE_PLAN });
    const liveTwoVega = liveTwo.calls.find((c) => c.cmd === "live_operate_step" && c.args.agent === "codex");
    ok(liveTwoVega && liveVega[0].args.sessionKey !== liveTwoVega.args.sessionKey,
      "LIVE e2e: a new orchestration run receives a new owned-session key", JSON.stringify({ first: liveVega[0].args.sessionKey, second: liveTwoVega && liveTwoVega.args.sessionKey }));

    // Existing repos have no workspace_prepare. LIVE still reads the effective
    // cwd and honors an explicit expectedFiles contract there.
    const REPO = "C:\\Users\\dev\\Desktop\\praxis";
    const liveRepo = await runChain({
      live: true,
      cwd: REPO,
      existingFiles: [{ rel: "src/orchestrator/orchestrator.ts", bytes: 100 }],
      maxIterations: 1,
      goal: "Fix the Praxis orchestrator using Vega and Forge.",
      planReply: JSON.stringify({ steps: [{ tool: "codex", prompt: "Edit the orchestrator", expectedFiles: ["src\\orchestrator\\orchestrator.ts"], why: "repair" }], summary: "repo repair" }),
    });
    ok(liveRepo.calls.some((c) => c.cmd === "workspace_manifest" && c.args.root === REPO) &&
        liveRepo.calls.some((c) => c.cmd === "live_operate_step" && c.args.folder === REPO),
      "LIVE e2e: an existing-repo step uses its effective cwd for manifest evidence and owned session", JSON.stringify(liveRepo.calls.filter((c) => c.cmd === "workspace_manifest" || c.cmd === "live_operate_step")));

    for (const phrase of ["through Praxis", "via Praxis", "using Praxis", "have Praxis delegate", "in the Praxis app"]) {
      ok(bc.isNewProjectGoal(`Make me a very concise personal website ${phrase}`), `MT-1 goal hygiene: ${phrase} -> new project`);
    }
    const briefRun = await runChain({ writesFiles: true, maxIterations: 1,
      goal: "Goal: Build a very concise personal website for Zach. Execution: Run this through Praxis and delegate work across Claude (Forge), Codex (Vega) and Cursor (Quill). Verification: Praxis must verify the build output. Done looks like: Praxis announces the result in Mission and Praxis should open it.",
      intent: "Make a very concise personal website for me. Run this through Praxis and delegate to Codex, Cursor, and Claude. Go." });
    ok(briefRun.calls.some((c) => c.cmd === "workspace_prepare"),
      "intent: an Atlas brief that names Praxis as the actor still builds in a NEW workspace (classified on Zach's words)",
      JSON.stringify(briefRun.calls.filter((c) => c.cmd === "workspace_prepare" || c.cmd === "agent_delegate").map((c) => [c.cmd, c.args.cwd ?? c.args.slug])));
    ok(!bc.isNewProjectGoal("Fix the Praxis Flight Deck") && bc.repoFolderFor("Fix the Praxis Flight Deck").id === "praxis", "MT-1 goal hygiene: fix the Praxis Flight Deck -> repo");
    // 2026-10-04: this exact sentence planned "Workspace: C:\\Users\\dev\\Desktop\\praxis".
    const tiny = "Make a tiny one-page website that just says hello from Praxis. Run it through Praxis and delegate to Codex, Cursor and Claude.";
    ok(bc.isNewProjectGoal(tiny), "goal hygiene: 'a tiny one-page website' is a new project (describing words are open-ended)");
    ok(bc.projectSlug(tiny) === "tiny-one-page-website", "goal hygiene: slug from the described thing", bc.projectSlug(tiny));
    ok(bc.isNewProjectGoal("create a website about Praxis") && bc.isNewProjectGoal('build a page that shows "Catalyzed Alpha"'),
      "goal hygiene: what the site SAYS or is ABOUT is content, not a repo");
    ok(bc.isNewProjectGoal("make a quick dark-mode dashboard"), "goal hygiene: hyphenated describing words");
    // Live 2026-10-10: "write" wasn't a build verb, so this built on the owner's Desktop.
    const temp = "Write a small Python command-line tool that converts temperatures between Celsius and Fahrenheit, with unit tests, in a new folder";
    ok(bc.isNewProjectGoal(temp), "goal hygiene: 'write a … tool … in a new folder' is a new project");
    ok(bc.projectSlug(temp) === "small-python-command-line-tool", "goal hygiene: slug for the written tool", bc.projectSlug(temp));
    ok(bc.isNewProjectGoal("put the scraper in a new folder") && bc.isNewProjectGoal("write a script that renames my photos"), "goal hygiene: 'in a new folder' and 'write a script' are new builds");
    ok(!bc.isNewProjectGoal("write a test for the flight deck count") && !bc.isNewProjectGoal("write the docs for praxis"), "goal hygiene: writing INTO a repo stays a repo job");
    ok(!bc.isNewProjectGoal("make a change to the flight deck page"), "goal hygiene: glue words end the description - a change is not a new page");
    ok(!bc.isNewProjectGoal("build a new landing page for the trading bot"), "goal hygiene: a repo named as the TARGET still wins");
    ok(JSON.stringify(bc.namedTeam("make me a concise personal website, delegate to Codex, Cursor and Claude")) === JSON.stringify(["codex", "cursor", "claude"]), "MT-1: delegate-to names all three agents");
    const good = await runChain({ writesFiles: true, maxIterations: 3 });
    const msgs = good.calls.filter((c) => c.cmd === "agent_chat_append" && c.args.agentId === "mission").map((c) => c.args.meta);
    ok(msgs.map((m) => m.kind).join(",") === "mission,plan,dispatch,progress,review,dispatch,progress,review,dispatch,progress,review,review,result",
      "MT-1: mission -> plan -> dispatch -> progress -> Praxis's review -> ... -> final review -> result, in order", JSON.stringify(msgs.map((m) => m.kind)));
    const stepReviews = msgs.filter((m) => m.kind === "review" && m.agent);
    ok(stepReviews.length === 3 && stepReviews.every((m) => m.verdict === "accepted" && m.text.trim()),
      "R4: every agent report is followed by Praxis's own visible review (accepted, with a reason)", JSON.stringify(stepReviews.map((m) => [m.agent, m.verdict, m.text])));
    const finalReview = msgs.filter((m) => m.kind === "review").at(-1);
    ok(!finalReview.agent && finalReview.verdict === "accepted" && /Final check passed/.test(finalReview.text),
      "R4: the whole result gets Praxis's final check in Mission before the result", JSON.stringify(finalReview));

    // R4: Praxis sends weak work back with concrete feedback, visibly, then accepts the fix.
    const sentBack = await runChain({ writesFiles: true, maxIterations: 3, supervisionReplies: [
      '{"sufficient":false,"feedback":"the hero has no headline and the nav links go nowhere"}',
      '{"sufficient":true,"feedback":"headline and working nav are there now"}',
    ] });
    const sbMsgs = sentBack.calls.filter((c) => c.cmd === "agent_chat_append" && c.args.agentId === "mission").map((c) => c.args.meta);
    const revise = sbMsgs.find((m) => m.kind === "review" && m.verdict === "revise");
    ok(revise && /no headline/.test(revise.text) && /Sent it back to Vega/.test(revise.text) && revise.agent === "vega",
      "R4: an insufficient result is sent back in Mission with Praxis's concrete feedback", JSON.stringify(revise));
    const accepted = sbMsgs.filter((m) => m.kind === "review" && m.verdict === "accepted" && m.agent === "vega")[0];
    ok(accepted && /headline and working nav/.test(accepted.text) && sbMsgs.indexOf(revise) < sbMsgs.indexOf(accepted),
      "R4: the fixed work is accepted with what Praxis checked, after the send-back", JSON.stringify(accepted));
    const reprompt = sentBack.calls.filter((c) => c.cmd === "agent_delegate" && /Supervisor feedback/.test(String(c.args.prompt)));
    ok(reprompt.length === 1 && /no headline/.test(String(reprompt[0].args.prompt)),
      "R4: the agent's re-prompt carries Praxis's feedback", JSON.stringify(reprompt.map((c) => String(c.args.prompt).slice(-200))));

    // R10: on Sovereign, Praxis takes one improvement pass after the goal is met, and says so.
    const sovereign = await runChain({ writesFiles: true, maxIterations: 4, autonomy: "full", verifyReplies: [
      JSON.stringify({ done: true, reason: "site complete", steps: [], summary: "site built", decisions: ["Added a dark-mode toggle - Zach works late"],
        improvements: [{ tool: "cursor", model: "grok-4.7-high", prompt: "Add a subtle dark-mode toggle to index.html", why: "improvement" }] }),
      '{"done":true,"reason":"better now","steps":[],"summary":"site built"}',
    ] });
    const svMsgs = sovereign.calls.filter((c) => c.cmd === "agent_chat_append" && c.args.agentId === "mission").map((c) => c.args.meta);
    ok(svMsgs.some((m) => m.kind === "decision" && /dark-mode toggle - Zach works late/.test(m.text)),
      "R10: a decision Praxis took is posted in Mission", JSON.stringify(svMsgs.filter((m) => m.kind === "decision").map((m) => m.text)));
    ok(svMsgs.some((m) => m.kind === "decision" && /making it better/.test(m.text)) &&
        sovereign.calls.some((c) => c.cmd === "agent_delegate" && /dark-mode toggle/.test(String(c.args.prompt))) && sovereign.result.done,
      "R10: Sovereign runs the improvement pass once, then delivers", JSON.stringify(sovereign.result.summary));
    const verifyPrompts = sovereign.calls.filter((c) => c.cmd === "hermes_brain" && /verifying your own delegated work/.test(String(c.args.goal)));
    ok(verifyPrompts.length === 2 && /SOVEREIGN/.test(String(verifyPrompts[0].args.goal)) && /"improvements"/.test(String(verifyPrompts[0].args.goal)) && !/"improvements"/.test(String(verifyPrompts[1].args.goal)),
      "R10: the improvement offer is made once — the second verify can't add another pass");
    const execute = await runChain({ writesFiles: true, maxIterations: 4, autonomy: "operator", verifyReplies: [
      JSON.stringify({ done: true, reason: "site complete", steps: [], summary: "site built",
        improvements: [{ tool: "cursor", prompt: "Add a dark-mode toggle", why: "improvement" }] }),
    ] });
    ok(execute.result.done && !execute.calls.some((c) => c.cmd === "agent_delegate" && /dark-mode toggle/.test(String(c.args.prompt))),
      "R10: below Sovereign, Praxis never builds unrequested improvements");

    // R8: a nearly-spent Codex window hands its steps to Quill, and the plan says why.
    // (No named team here: a named agent keeps at least one step - the owner asked for it.)
    const balanced = await runChain({ writesFiles: true, maxIterations: 2, goal: "Make a tiny one-page website that says hello", usageRows: [
      { key: "codex", plan: [{ label: "Codex · Plus · 5h window", window: "5h", used: 92, limit: 100, unit: "percent", basis: "real" }, { label: "Codex · Plus · weekly", window: "weekly", used: 40, limit: 100, unit: "percent", basis: "real" }] },
      { key: "cursor", plan: [{ label: "Cursor · pro · CURSOR MODELS", window: "credits", used: 5, limit: 100, unit: "percent", basis: "real", resets_at: Date.now() + 20 * 86400000 }] },
    ] });
    const blMsgs = balanced.calls.filter((c) => c.cmd === "agent_chat_append" && c.args.agentId === "mission").map((c) => c.args.meta);
    const blPlan = blMsgs.find((m) => m.kind === "plan");
    ok(/Balanced the load: Vega → Quill \(Codex: 5h 92%/.test(blPlan.text) && !balanced.calls.some((c) => c.cmd === "agent_delegate" && c.args.tool === "codex"),
      "R8: steps leave a nearly-spent Codex window for Cursor, and the plan says so", blPlan.text);
    const named = await runChain({ writesFiles: true, maxIterations: 2, usageRows: [
      { key: "codex", plan: [{ label: "Codex · Plus · 5h window", window: "5h", used: 92, limit: 100, unit: "percent", basis: "real" }] },
      { key: "cursor", plan: [{ label: "Cursor · pro · CURSOR MODELS", window: "credits", used: 5, limit: 100, unit: "percent", basis: "real", resets_at: Date.now() + 20 * 86400000 }] },
    ] });
    ok(named.calls.some((c) => c.cmd === "agent_delegate" && c.args.tool === "codex"),
      "R8: an agent Zach NAMED keeps its share even when its window is low");
    const capacityCall = balanced.calls.find((c) => c.cmd === "hermes_brain" && /Capacity right now/.test(String(c.args.goal)));
    ok(capacityCall && /Codex: 5h 92%, weekly 40% used \(headroom 8%\)/.test(String(capacityCall.args.goal)),
      "R8: the planner sees the live capacity of every rail", capacityCall ? String(capacityCall.args.goal).match(/Capacity[\s\S]{0,300}/)[0] : "no capacity block");
    ok(msgs.at(-1).artifacts.some((a) => a.kind === "preview" && a.target.startsWith("file:///")) && good.ledger.build.missionId === msgs[0].missionId,
      "MT-1: closing result and persisted run have workspace artifacts and missionId");
    ok(good.events.filter((e) => e.type === "agent:status" && e.status === "working").every((e) => e.taskId === "j.test-mission" && e.areaId === "ventures"),
      "MT-1: working agents carry taskId and areaId at dispatch");
    const targetEvents = good.events.filter((e) => e.taskId === "j.test-mission" && /^task:/.test(e.type));
    ok(targetEvents.length > 0 && targetEvents.at(-1).type === "task:complete",
      "a finished mission's last task event is task:complete - no progress tick re-activates it (HUD stuck on EXECUTING, live 2026-10-01)",
      JSON.stringify(targetEvents.slice(-3).map((e) => e.type)));
    const rerun = await runChain({ writesFiles: true, maxIterations: 1, cursorError: "You're out of usage" });
    const rerunCalls = rerun.calls.filter((c) => c.cmd === "agent_delegate");
    const cursorAt = rerunCalls.findIndex((c) => c.args.tool === "cursor");
    ok(cursorAt >= 0 && rerunCalls[cursorAt + 1].args.tool === "codex" && rerunCalls[cursorAt + 1].args.prompt === rerunCalls[cursorAt].args.prompt && rerunCalls[cursorAt + 1].args.cwd === rerunCalls[cursorAt].args.cwd,
      "MT-1: Quill out of usage immediately retries same task and cwd on Vega");
    ok(rerun.result.done && rerun.calls.filter((c) => c.cmd === "agent_chat_append" && c.args.meta.kind === "reroute").length === 1,
      "MT-1: recovered mission done:true with exactly one reroute");
    const benched = await runChain({ writesFiles: true, maxIterations: 1, cursorPool: { models_pool_pct: 100, api_pool_pct: 100, api_pool_allowed: true, note: "", resets_at_ms: Date.now() + 86400000 } });
    ok(benched.result.done && !benched.calls.some((c) => c.cmd === "agent_delegate" && c.args.tool === "cursor"), "MT-1: benched named Cursor still ends done:true");
    ok(policy.isAvailabilityOnlyStep("Record the blocker: Cursor is out of usage") && policy.isAvailabilityOnlyStep("Verify Cursor is accessible") && !policy.isAvailabilityOnlyStep("Fix the website navigation"),
      "MT-1: availability-check busywork excluded by pure policy");
    for (const raw of ["You're out of usage", "You've hit your session limit", "401 Unauthorized", "signed out", "rate limit", "breaker is off"]) {
      ok(drivers.classifyToolFailure("cursor", raw), `MT-1: availability failure recognized: ${raw}`);
    }
    ok(policy.cursorPoolExhaustion({ models_pool_pct: 100, api_pool_pct: 100, api_pool_allowed: true }) && !policy.cursorPoolExhaustion({ models_pool_pct: 20, api_pool_pct: 10 }), "MT-1: Cursor API permission cannot hide exhausted pools");
    ok(good.calls.filter((c) => c.cmd === "agent_delegate").every((c) => /headless: true/.test(c.args.prompt) && /finally block/.test(c.args.prompt)), "MT-1: all step prompts require headless QA and server cleanup");
    ok(good.calls.filter((c) => c.cmd === "desktop_open_url").length === 1, "MT-1: Praxis opens the requested finished preview exactly once");
    const delegations = good.calls.filter((c) => c.cmd === "agent_delegate");
    ok(good.result.done === true, "chain e2e: the run is verified done", JSON.stringify(good.result.summary));
    ok(["codex", "cursor", "claude"].every((t) => delegations.some((d) => d.args.tool === t)),
      "chain e2e: Vega, Quill AND Forge all actually ran", JSON.stringify(delegations.map((d) => d.args.tool)));
    ok(delegations.every((d) => d.args.cwd === good.WS), "chain e2e: every agent ran in the new workspace, never the Praxis repo",
      JSON.stringify(delegations.map((d) => d.args.cwd)));
    ok(delegations.every((d) => d.args.prompt.includes("PRAXIS-BRIEF.md") && /Do NOT open a browser/.test(d.args.prompt)),
      "chain e2e: every agent is pointed at the brief and told Praxis handles delivery");
    ok(!delegations.some((d) => d.args.tool === "cursor" && d.args.model === "gpt-6-astra-medium"),
      "chain e2e: a model Cursor can't run never reaches cursor-agent");
    const brief = good.calls.find((c) => c.cmd === "workspace_write_file" && c.args.rel === "PRAXIS-BRIEF.md");
    ok(brief && brief.args.content.includes(good.MEM) && brief.args.content.includes(SENTENCE.trim()),
      "chain e2e: the brief carries Zach's words and the REAL memory source file");
    const planCall = good.calls.find((c) => c.cmd === "hermes_brain" && /^You are the Praxis orchestrator brain\. Given a goal/.test(c.args.goal));
    ok(planCall && /STATIC site opened straight from disk/.test(planCall.args.goal) && /Forge = claude/.test(planCall.args.goal) && /Who Zach is/.test(planCall.args.goal) && /Each available member gets a real share/.test(planCall.args.goal),
      "chain e2e: the planner sees the team mapping, the requirement, and the recalled memory");
    const verifyCall = good.calls.find((c) => c.cmd === "hermes_brain" && /verifying your own delegated work/.test(c.args.goal));
    ok(verifyCall && /GROUND TRUTH/.test(verifyCall.args.goal) && /index\.html/.test(verifyCall.args.goal),
      "chain e2e: verify judges the files on disk, not the agents' claims");
    const opened = good.calls.find((c) => c.cmd === "desktop_open_url");
    const maxed = good.calls.find((c) => c.cmd === "desktop_window_control");
    ok(opened && opened.args.url === `${good.WS}\\index.html` && maxed && maxed.args.action === "maximize" && maxed.args.target === "Zach Adams — Builder",
      "chain e2e: the finished page is opened and ITS window maximized");
    ok(good.ledger && good.ledger.done === true && good.ledger.build && good.ledger.build.memory[0].path === good.MEM &&
        good.ledger.build.workspace === good.WS && good.ledger.build.delivery && good.ledger.build.delivery.maximized === true,
      "chain e2e: runs.jsonl records the workspace, the memory it used, and the delivery", JSON.stringify(good.ledger && good.ledger.build));
    ok(/is done in/.test(good.result.summary) && /Vega/.test(good.result.summary), "chain e2e: the summary says what was built and by whom", good.result.summary);

    // HALT thrown while the first agent runs: no further agent may start.
    const halted = await runChain({
      writesFiles: true,
      maxIterations: 2,
      onDelegate: () => localStorage.setItem("praxis.halted.v1", "1"),
    });
    const haltedDelegations = halted.calls.filter((c) => c.cmd === "agent_delegate");
    ok(haltedDelegations.length === 1 && halted.result.done === false && !halted.calls.some((c) => c.cmd === "desktop_open_url"),
      "chain e2e: HALT ALL thrown mid-plan stops the NEXT agent from starting (not just the next iteration)",
      JSON.stringify(haltedDelegations.map((d) => d.args.tool)));

    // Agents that time out but leave real work: the files decide, not the exit codes.
    const partial = await runChain({ writesFiles: true, delegateThrows: true, maxIterations: 2 });
    ok(partial.result.done === true && partial.calls.some((c) => c.cmd === "desktop_open_url"),
      "chain e2e: every step 'failed' (timeouts) but the site is on disk — verified and delivered, not abandoned",
      JSON.stringify(partial.result.summary));
    ok(partial.calls.some((c) => c.cmd === "workspace_write_file" && c.args.rel === ".praxis-done"),
      "chain e2e: a verified-done build is marked so a later ask starts fresh");
    ok(good.calls.some((c) => c.cmd === "workspace_prepare" && c.args.resume === true),
      "chain e2e: a same-day re-ask asks Rust to resume an unfinished build");
    const resumed = await runChain({ writesFiles: true, maxIterations: 2, existingFiles: [{ rel: "PRAXIS-BRIEF.md", bytes: 900 }, { rel: "index.html", bytes: 65465 }] });
    const resumedPlan = resumed.calls.find((c) => c.cmd === "hermes_brain" && /^You are the Praxis orchestrator brain. Given a goal/.test(c.args.goal));
    const resumedDelegations = resumed.calls.filter((c) => c.cmd === "agent_delegate");
    ok(resumedDelegations.length === 2 && !resumedDelegations.some((d) => d.args.tool === "claude"),
      "chain e2e: a resumed build runs only the steps the planner chose — the team is not forced through again",
      JSON.stringify(resumedDelegations.map((d) => d.args.tool)));
    ok(good.calls.filter((c) => c.cmd === "agent_delegate").every((d) => /NEVER start a server/.test(d.args.prompt)),
      "chain e2e: agents are told never to start servers or background processes (they hang the run)");
    ok(resumedPlan && /ALREADY holds an unfinished build/.test(resumedPlan.args.goal) && /index.html/.test(resumedPlan.args.goal),
      "chain e2e: resuming tells the planner to CONTINUE the existing files, not start over");
    const fresh = await runChain({ writesFiles: true, maxIterations: 2, goal: SENTENCE.replace("Create a personal website", "Create a personal website from scratch") });
    ok(fresh.calls.some((c) => c.cmd === "workspace_prepare" && c.args.resume === false),
      "chain e2e: 'from scratch' never resumes");

    const openOnly = await runChain({
      writesFiles: true,
      maxIterations: 3,
      verifyReply: '{"done":false,"reason":"site not yet opened in a browser","steps":[{"tool":"cursor","prompt":"Open the website in a visible browser and maximize the window.","why":"delivery"}],"summary":"x"}',
    });
    ok(openOnly.result.done === true && openOnly.calls.some((c) => c.cmd === "desktop_open_url") &&
        openOnly.calls.filter((c) => c.cmd === "agent_delegate").length === 3,
      "chain e2e: a verdict that only asks to open the site is done — Praxis delivers instead of looping another agent pass",
      JSON.stringify(openOnly.result.summary));
    const vcall = good.calls.find((c) => c.cmd === "hermes_brain" && /verifying your own delegated work/.test(c.args.goal));
    ok(vcall && /done by Praxis ITSELF immediately after you return done:true/.test(vcall.args.goal),
      "chain e2e: the verifier is told delivery happens after done");

    // Live run 4 follow-ups (2026-09-16 23:30).
    ok(resumedPlan && !/Each available member gets a real share/.test(resumedPlan.args.goal) && resumedPlan.args.goal.includes('"steps": [] when the files already meet the goal'),
      "chain e2e: a resumed plan is NOT told to put every named agent through again, and may be empty");
    const EXISTING = [{ rel: "PRAXIS-BRIEF.md", bytes: 900 }, { rel: "index.html", bytes: 65465 }];
    const complete = await runChain({ writesFiles: false, maxIterations: 2, existingFiles: EXISTING, planReply: '{"steps":[],"summary":"already complete"}' });
    const completeVerify = complete.calls.find((c) => c.cmd === "hermes_brain" && /verifying your own delegated work/.test(c.args.goal));
    ok(complete.result.done === true && complete.calls.filter((c) => c.cmd === "agent_delegate").length === 0 &&
        completeVerify && /no agent ran/.test(completeVerify.args.goal) && complete.calls.some((c) => c.cmd === "desktop_open_url"),
      "chain e2e: a resumed build the planner judges complete runs no agent, is verified from disk, and is delivered (never 'every step failed')",
      JSON.stringify(complete.result.summary));
    const freshEmpty = await runChain({ writesFiles: true, maxIterations: 2, planReply: '{"steps":[],"summary":"x"}' });
    ok(freshEmpty.calls.filter((c) => c.cmd === "agent_delegate").length >= 3,
      "chain e2e: an EMPTY plan for a fresh build is malformed — the named team still builds it",
      JSON.stringify(freshEmpty.calls.filter((c) => c.cmd === "agent_delegate").map((c) => c.args.tool)));
    ok(parsePlan('{"steps":[],"summary":"done"}', { allowEmpty: true }).steps.length === 0 && parsePlan('{"steps":[],"summary":"done"}').steps.length === 1 &&
        parsePlan('{"steps":[{"tool":"nope"}],"summary":"x"}', { allowEmpty: true }).steps.length === 1,
      "plan: only an explicitly empty list may be empty, and only where allowed");
    ok(bc.isDeliveryOnlyStep("Make the hero show Zach's real projects instead of the generic list") === false &&
        bc.isDeliveryOnlyStep("Start a persistent local server so the site stays viewable") === true &&
        bc.isDeliveryOnlyStep("Open index.html in Edge and maximize it") === true &&
        bc.isDeliveryOnlyStep("Display the case studies as cards") === false,
      "chain: 'show'/'display' in real file work is not delivery (a false match would call an unfinished build done)");

    // A cancelled run stops ITS agent CLI, not just the wait for it.
    {
      const controller = new AbortController();
      const aborted = await runChain({ writesFiles: true, maxIterations: 2, signal: controller.signal, onDelegate: () => controller.abort() });
      await new Promise((r) => setTimeout(r, 20));
      const firstDelegation = aborted.calls.find((c) => c.cmd === "agent_delegate");
      const abortCall = aborted.calls.find((c) => c.cmd === "agent_delegate_abort");
      ok(firstDelegation && typeof firstDelegation.args.delegationId === "string" && firstDelegation.args.delegationId.length > 8 &&
          abortCall && abortCall.args.delegationId === firstDelegation.args.delegationId,
        "chain e2e: aborting a run kills the exact agent it started (delegationId), live 2026-09-16 a stopped agent kept editing",
        JSON.stringify({ delegationId: firstDelegation && firstDelegation.args.delegationId, abort: abortCall && abortCall.args }));
      ok(aborted.calls.filter((c) => c.cmd === "agent_delegate").length === 1 && aborted.result.done === false,
        "chain e2e: nothing else starts after the abort");
    }
    {
      const haltSrc = fs.readFileSync(path.join(__dirname, "..", "src", "command", "haltStore.ts"), "utf8");
      const libSrc = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "lib.rs"), "utf8");
      const haltBlock = haltSrc.slice(haltSrc.indexOf("if (halted) {"), haltSrc.indexOf("if (halted) {") + 1200);
      ok(haltBlock.includes('invoke("agent_delegate_abort_all")') && haltBlock.includes('invoke("live_operate_abort_all")') && /hermes_bridge::agent_delegate_abort_all,/.test(libSrc) && /hermes_bridge::agent_delegate_abort,/.test(libSrc),
        "HALT ALL stops agent CLIs and owned LIVE chats");
    }

    // Live run 5 follow-ups (2026-09-17 00:28): what the owner sees and hears at the end.
    {
      const slowTeach = await runChain({ writesFiles: true, maxIterations: 2, failTools: ["claude"], teachDelayMs: 4000 });
      ok(slowTeach.result.done === true && slowTeach.elapsedMs < 2500,
        "chain e2e: the Hermes lesson write never holds the finished result (live: Atlas said done a minute after the site was maximized)",
        `elapsed ${slowTeach.elapsedMs} ms`);
      ok(/built by Vega and Quill \(Forge didn't finish its step\)/.test(slowTeach.result.summary),
        "chain e2e: an agent whose step timed out is named, not silently dropped from the credit", slowTeach.result.summary);
      ok(/I opened it in your browser and maximized the window\./.test(good.result.summary) && !/Maximized Zach/.test(good.result.summary),
        "chain e2e: the spoken summary states the delivery, not the raw browser window title", good.result.summary);
      ok(good.calls.filter((c) => c.cmd === "agent_delegate").every((d) => /aim to reply within about 20 minutes/.test(d.args.prompt)),
        "chain e2e: every agent gets a time budget and is told to keep its notes as it goes (live: Quill spent 30 min on 1-byte CSS tweaks)");
    }

    const empty = await runChain({ writesFiles: false, maxIterations: 2 });
    ok(empty.result.done === false, "chain e2e: agents that write nothing never reach done, however confident the brain is",
      JSON.stringify(empty.result.summary));
    ok(!empty.calls.some((c) => c.cmd === "desktop_open_url"), "chain e2e: nothing is opened when the build isn't verified");
    ok(/isn't verified done/.test(empty.result.summary), "chain e2e: the summary says it isn't done and why", empty.result.summary);
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
