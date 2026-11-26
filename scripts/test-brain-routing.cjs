/** Headless contract test for first-run brain and spoken-alias routing. */
const path = require("path");
const esbuild = require("esbuild");

class FakeLocalStorage {
  constructor() {
    this.values = new Map();
  }
  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
  removeItem(key) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}

global.localStorage = new FakeLocalStorage();

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

const store = loadModule("src/command/brainStore.ts");
const runtime = loadModule("src/orchestrator/brain.ts");
const fleet = loadModule("src/command/fleetStore.ts");
const toolPolicy = loadModule("src/shared/toolPolicyPersistence.ts");
const board = loadModule("src/orchestrator/boardContributors.ts");
const BRAIN_KEY = "praxis.brain.v1";
const BRAIN_DEFAULTS_KEY = "praxis.brain.defaults.v2";
const FLEET_KEY = "praxis.fleet.models.v1";
const TOOLS_KEY = "praxis.tools.v1";
const TOOLS_DEFAULTS_KEY = "praxis.tools.defaults.v5";
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

ok(store.DEFAULT_BRAIN.provider === "claude-max" && store.DEFAULT_BRAIN.model === "claude-opus-5-5", "picker defaults to Opus 5.5 on the Claude subscription", JSON.stringify(store.DEFAULT_BRAIN));
ok(runtime.FIRST_RUN_DEFAULT.provider === "claude-max" && runtime.FIRST_RUN_DEFAULT.model === "claude-opus-5-5", "runtime first-run default matches picker", JSON.stringify(runtime.FIRST_RUN_DEFAULT));
ok(store.resolveBrainByName("chatgpt")?.provider === "openai-codex", "spoken chatgpt resolves to subscription, not paid API");
ok(store.resolveBrainByName("use chatgpt")?.provider === "openai-codex", "chatgpt collision still resolves to Codex in a spoken phrase");
ok(store.resolveBrainByName("openai api")?.provider === "openai-api", "explicit openai api resolves to paid API rail");
ok(store.resolveBrainByName("claude")?.provider === "claude-max", "explicit claude remains selectable and runtime-checked");
ok(store.resolveBrainByName("switch to gpt 5.6 terra")?.model === "gpt-5.6-terra", "qualified Terra phrase cannot collapse to Sol");
ok(store.resolveBrainByName("switch to gpt-5.6 luna")?.model === "gpt-5.6-luna", "qualified Luna phrase cannot collapse to Sol");
ok(store.resolveBrainByName("switch to openai api luna")?.model === "gpt-5.6-luna", "qualified OpenAI API Luna phrase wins over generic API alias");

const forge = fleet.FLEET_AGENTS.find((a) => a.key === "forge");
const vega = fleet.FLEET_AGENTS.find((a) => a.key === "vega");
const quill = fleet.FLEET_AGENTS.find((a) => a.key === "quill");
ok(forge?.options[0]?.billing === "claude-max", "Forge keeps the Claude subscription catalog", JSON.stringify(forge?.options[0]));
ok(vega?.options[0]?.billing === "chatgpt", "Vega keeps the Codex subscription catalog", JSON.stringify(vega?.options[0]));
ok(quill?.options[0]?.billing === "cursor-sub", "Quill keeps the Cursor subscription catalog", JSON.stringify(quill?.options[0]));
ok(fleet.FLEET_AGENTS.some((a) => a.options.some((o) => o.billing !== "openai-api")), "fleet is not flattened onto the paid OpenAI API rail");

localStorage.clear();
localStorage.setItem(FLEET_KEY, JSON.stringify({ forge: "gpt-5.6-sol", vega: "gpt-5.6-sol", quill: "gpt-5.6-terra" }));
ok(fleet.getFleetSelection("forge")?.billing === "claude-max" && fleet.getFleetSelection("quill")?.billing === "cursor-sub", "legacy all-OAI fleet selections migrate to each row's subscription default");
ok(fleet.defaultModelForTool("claude") === "claude-opus-5-5", "Claude driver reads Forge's Opus 5.5 default");
ok(fleet.defaultModelForTool("codex") === "gpt-6-astra", "Codex driver reads Vega's Astra default");
ok(fleet.defaultModelForTool("cursor") === "grok-4.7-high", "Quill defaults to Grok 4.7 explicitly (never Auto, which can bill Cursor's API pool)");
ok(quill.options.every((o) => /^(?:composer-2\.5|cursor-grok-4\.6-(?:low|medium|high|xhigh)|grok-4\.7-(?:low|medium|high|xhigh))$/.test(o.id)), "Quill's menu offers only Cursor Models pool ids", JSON.stringify(quill.options.map((o) => o.id)));

// Breaker defaults: the two-sided contract.
//
// A stored `false` is normally the owner having cut a tool on purpose, and is sacred. A defaults
// VERSION bump is the one event allowed to resolve that ambiguity.

// 1. At a version bump, the new table wins ONCE. (v7, 2026-09-09: all six on.)
localStorage.clear();
localStorage.setItem("praxis.tools.v1", JSON.stringify({ claude: true, codex: false, cursor: true, hermes: false }));
const migratedTools = toolPolicy.readToolToggles(localStorage);
ok(
  Object.values(migratedTools).every((v) => v === true),
  "a defaults version bump turns every breaker on once",
  JSON.stringify(migratedTools),
);
ok(localStorage.getItem("praxis.tools.defaults.v7") === "7", "the bump writes its own stable version marker");

// 2. Once the marker is current, an explicit cut is preserved - forever.
localStorage.clear();
localStorage.setItem("praxis.tools.defaults.v7", "7");
localStorage.setItem("praxis.tools.v1", JSON.stringify({ claude: true, codex: false, cursor: true, hermes: false }));
const steadyTools = toolPolicy.readToolToggles(localStorage);
ok(
  steadyTools.claude === true && steadyTools.codex === false && steadyTools.cursor === true && steadyTools.hermes === false,
  "with the marker current, every explicit boolean is preserved",
  JSON.stringify(steadyTools),
);
ok(
  steadyTools.openrouter === true && steadyTools["computer-use"] === true,
  "and absent fields still fill from the current defaults",
  JSON.stringify(steadyTools),
);

// This assertion had quietly stopped testing anything. It said "when Claude
// breaker is off" but only called localStorage.clear(), leaning on an era when a
// cleared profile meant every breaker off. Once `claude` started defaulting ON,
// the breaker under test was ON, no error came back, and a real safety property
// sat red for weeks reading like a known-broken test. Turn the breaker off
// explicitly, and the property is checked again.
localStorage.clear();
localStorage.setItem("praxis.tools.defaults.v7", "7");
localStorage.setItem("praxis.tools.v1", JSON.stringify({ claude: false }));
let boardRoute = board.boardRouteForSelection({ id: "opus", label: "Opus", billing: "claude-max", note: "" });
ok(!!boardRoute.error && boardRoute.provider === "claude-max", "board route fails closed when the Claude breaker is off", JSON.stringify(boardRoute));

// ...and the other half: with the breaker ON, the same selection routes.
localStorage.clear();
boardRoute = board.boardRouteForSelection({ id: "opus", label: "Opus", billing: "claude-max", note: "" });
ok(!boardRoute.error && boardRoute.provider === "claude-max", "with the breaker closed, the same selection routes", JSON.stringify(boardRoute));
boardRoute = board.boardRouteForSelection({ id: "gpt-5.6-sol", label: "Sol", billing: "chatgpt", note: "" });
ok(!boardRoute.error && boardRoute.provider === "openai-codex" && boardRoute.model === undefined, "board route uses enabled Codex subscription without an API model call");
boardRoute = board.boardRouteForSelection({ id: "", label: "Composer", billing: "cursor-sub", note: "" });
ok(!!boardRoute.error && boardRoute.provider === "cursor", "board route never disguises Cursor as NVIDIA or paid OAI");
boardRoute = board.boardRouteForSelection(null);
ok(!!boardRoute.error && boardRoute.provider === "unavailable", "missing board selection fails closed instead of defaulting to paid OAI");

ok(board.CONTRIBUTOR_KEYS.length === 10, "board roster has 10 identities", JSON.stringify(board.CONTRIBUTOR_KEYS));
ok(
  ["ledger", "relay", "hermes"].every((k) => board.CONTRIBUTOR_KEYS.includes(k)),
  "Ledger, Relay and Hermes have contributor seats",
);

function stubInputs(over = {}) {
  return {
    recent_runs: [],
    recent_runs_age_days: null,
    total_runs_in_ledger: 0,
    recent_run_note_files: [],
    open_now: [],
    spend_by_tool: [],
    models_active: [],
    research_inbox: "",
    research_inbox_present: false,
    forge_runs: [],
    vega_runs: [],
    latest_org_report: "",
    latest_org_report_file: "",
    vault_stats: { total_nodes: 0, total_edges: 0, nodes_by_area: [], nodes_by_kind: [], orphan_count: 0, present: false },
    ...over,
  };
}

const emptyLedger = board.ledgerContribution(stubInputs());
ok(emptyLedger.ok && emptyLedger.bullets[0] === "No runs in the ledger yet.", "empty ledger says so honestly");

const july = Date.parse("2026-07-02T12:00:00");
const staleLedger = board.ledgerContribution(stubInputs({
  total_runs_in_ledger: 4,
  recent_runs_age_days: 76,
  recent_runs: [{ ts: july, goal: "Command center opens full screen", done: true, tools: ["claude"], ok_steps: 1, total_steps: 1 }],
}));
ok(/^No runs in the window — last run was /.test(staleLedger.bullets[0]), "stale ledger names the last-run date, not yesterday", staleLedger.bullets[0]);
ok(!/yesterday/i.test(staleLedger.bullets.join(" ")), "an old run is never presented as recent");

const liveLedger = board.ledgerContribution(stubInputs({
  total_runs_in_ledger: 3,
  recent_runs: [
    { ts: Date.now(), goal: "today's work", done: true, tools: ["claude"], ok_steps: 1, total_steps: 1 },
    { ts: Date.now() - 1000, goal: "also today", done: false, tools: ["codex"], ok_steps: 0, total_steps: 1 },
  ],
}));
ok(/2 runs in the window \(1 done, 1 failed\)/.test(liveLedger.bullets[0]), "windowed ledger counts done vs failed", liveLedger.bullets[0]);

const relay = board.relayContribution();
ok(relay.ok && /no board seat/i.test(relay.bullets[0]), "Relay states its missing seat instead of going silent", relay.bullets[0]);

const hermesOff = board.hermesBullets(false, { degraded: true, reason: "planning brain (Hermes) unreachable — voice unaffected" });
ok(/planning is OFF/i.test(hermesOff[0]) && /unreachable/i.test(hermesOff[1]), "Hermes reports the toggle and live CLI health", hermesOff.join(" | "));

localStorage.clear();
let routed = runtime.selectedBrainWithGate();
ok(routed.provider === "claude-max" && routed.model === "claude-opus-5-5" && !routed.rerouted, "no persisted brain thinks on Opus 5.5", JSON.stringify(routed));
ok(store.getSelectedBrain().provider === "claude-max", "picker reader also uses Opus 5.5 with no persisted choice", JSON.stringify(store.getSelectedBrain()));
ok(JSON.stringify(routed.fallbacks.map((r) => r.provider)) === JSON.stringify(["openai-codex", "openai-api", "nvidia"]),
  "brain order: Codex subscription, then the API backup, then free NVIDIA", JSON.stringify(routed.fallbacks));

// The one-time move (owner request 2026-10-10): his stored GPT-6 Astra on the paid API lands on Opus 5.5.
localStorage.clear();
localStorage.setItem(BRAIN_KEY, JSON.stringify({ provider: "openai-api", model: "gpt-6-astra" }));
routed = runtime.selectedBrainWithGate();
ok(routed.provider === "claude-max" && routed.model === "claude-opus-5-5", "a stored API brain moves to Opus 5.5 once", JSON.stringify(routed));
ok(localStorage.getItem("praxis.brain.upgrade.opus55") === "1", "the Opus 5.5 move is marked so it runs only once");

localStorage.clear();
localStorage.setItem("praxis.brain.upgrade.opus55", "1"); // the one-time Opus move already happened
localStorage.setItem(BRAIN_KEY, JSON.stringify({ provider: "openai-api", model: "gpt-5.6-sol" }));
localStorage.setItem(FLEET_KEY, JSON.stringify({
  forge: "gpt-5.6-sol",
  vega: "gpt-5.6-sol",
  quill: "gpt-5.6-terra",
  sage: "gpt-5.6-terra",
  lens: "gpt-5.6-terra",
  atlas: "gpt-5.6-luna",
  scribe: "gpt-5.6-luna",
}));
// The rule these two cases protect is intact and still worth having - nothing GUESSES a paid
// model - but an instruction is not a guess. It runs once, behind its own marker, and a
// deliberate re-pick of Sol afterwards survives every restart.
ok(store.getSelectedBrain().provider === "openai-api" && store.getSelectedBrain().model === "gpt-6-astra", "legacy Sol is carried to Astra by the one-time authorized upgrade", JSON.stringify(store.getSelectedBrain()));
ok(localStorage.getItem(BRAIN_DEFAULTS_KEY) === "2", "subscription-default migration marker is versioned exactly once");

localStorage.clear();
localStorage.setItem("praxis.brain.upgrade.opus55", "1");
localStorage.setItem(BRAIN_KEY, JSON.stringify({ provider: "openai-api", model: "gpt-5.6-sol" }));
ok(store.getSelectedBrain().provider === "openai-api" && store.getSelectedBrain().model === "gpt-6-astra", "an explicit Sol choice is carried to Astra once, then left alone", JSON.stringify(store.getSelectedBrain()));

// ...and "once" means once: with the marker already set, a deliberate Sol pick is
// untouched. This is the half that keeps the original protection real.
localStorage.clear();
localStorage.setItem("praxis.brain.upgrade.astra", "1");
localStorage.setItem("praxis.brain.upgrade.opus55", "1");
localStorage.setItem(BRAIN_KEY, JSON.stringify({ provider: "openai-api", model: "gpt-5.6-sol" }));
ok(store.getSelectedBrain().model === "gpt-5.6-sol", "after the one-time upgrade, an explicit Sol choice is preserved", JSON.stringify(store.getSelectedBrain()));

localStorage.clear();
localStorage.setItem("praxis.brain.upgrade.opus55", "1");
localStorage.setItem(BRAIN_KEY, JSON.stringify({ provider: "openai-api", model: "gpt-5.6-terra" }));
ok(store.getSelectedBrain().provider === "openai-api" && store.getSelectedBrain().model === "gpt-5.6-terra", "after the Opus move, a deliberate API choice is preserved", JSON.stringify(store.getSelectedBrain()));

// Same shape of rot: this leaned on a cleared profile meaning "claude breaker
// off", so it was really testing the breaker, not authentication. Cut the breaker
// explicitly and the reroute is exercised for the reason it exists.
localStorage.clear();
localStorage.setItem("praxis.tools.defaults.v7", "7");
localStorage.setItem("praxis.tools.v1", JSON.stringify({ claude: false }));
localStorage.setItem(BRAIN_KEY, JSON.stringify({ provider: "claude-max", model: "opus" }));
routed = runtime.selectedBrainWithGate();
ok(routed.provider === "openai-codex" && routed.model === "gpt-6-astra" && routed.rerouted, "a cut Claude breaker hands the brain to the Codex subscription, not straight to the free rail", JSON.stringify(routed));
ok(!routed.fallbacks.some((r) => r.provider === "claude-max"), "a cut breaker's rail is never in the fallback order", JSON.stringify(routed.fallbacks));

// With every breaker closed - which is now the shipped default - it stays on Claude.
localStorage.clear();
localStorage.setItem(BRAIN_KEY, JSON.stringify({ provider: "claude-max", model: "opus" }));
routed = runtime.selectedBrainWithGate();
ok(routed.provider === "claude-max" && !routed.rerouted, "with the breaker closed, a Claude selection stays on Claude", JSON.stringify(routed));

localStorage.setItem(TOOLS_KEY, JSON.stringify({ claude: true, codex: true }));
localStorage.setItem(TOOLS_DEFAULTS_KEY, "5");
routed = runtime.selectedBrainWithGate();
ok(routed.provider === "claude-max" && routed.model === "claude-opus-5-5" && !routed.rerouted, "explicitly enabled Claude CLI selection remains explicit", JSON.stringify(routed));

localStorage.setItem(BRAIN_KEY, JSON.stringify({ provider: "claude-max", model: "claude-fable-5" }));
routed = runtime.selectedBrainWithGate();
ok(routed.provider === "claude-max" && routed.model === "claude-opus-5-5" && !routed.rerouted, "stale Fable persistence cannot revive an unverified Claude route", JSON.stringify(routed));
ok(store.getSelectedBrain().model === "claude-opus-5-5", "picker reader rejects stale Fable persistence too", JSON.stringify(store.getSelectedBrain()));

localStorage.setItem(BRAIN_KEY, "{not-json");
routed = runtime.selectedBrainWithGate();
ok(routed.provider === "nvidia" && !routed.rerouted, "corrupt persisted brain fails closed to NVIDIA", JSON.stringify(routed));

// A failed brain call is spoken aloud: a sentence, never a provider's JSON body.
const creditBody = 'openai responses gpt-6-astra HTTP 429 Too Many Requests: {"error":{"code":"credit_balance_exhausted","message":"You have no credits remaining"}}';
ok(/credit is used up/.test(runtime.brainFailureReply(creditBody)) && !/\{/.test(runtime.brainFailureReply(creditBody)),
  "an empty OpenAI wallet becomes the plain credit sentence", runtime.brainFailureReply(creditBody));
const otherBody = 'anthropic HTTP 500 Internal Server Error: {"type":"error","error":{"type":"api_error"}}';
ok(runtime.brainFailureReply(otherBody) === "my brain hit a snag — anthropic HTTP 500 Internal Server Error",
  "other failures keep the status line and drop the body", runtime.brainFailureReply(otherBody));
ok(runtime.brainFailureReply("x".repeat(400)).length <= 140, "a long error is cut to something speakable");
ok(/unreachable/.test(runtime.brainFailureReply("")), "an empty error still says something honest");
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
