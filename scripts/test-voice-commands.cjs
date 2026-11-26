/**
 * test-voice-commands - headless logic test for the PURE voice command router.
 *
 * The mic + STT need the owner's voice, but the GRAMMAR (utterance → Praxis verb) is
 * pure and fully testable. We transpile src/voice/commands.ts on the fly with
 * esbuild (no dep added; vite already bundles it) and assert each phrase resolves
 * to the right intent - including the guards (e.g. "what's next" stays a question,
 * not a task-hop; "dump box" opens the box but "dump <idea>" captures it).
 *
 * Run: node scripts/test-voice-commands.cjs
 */
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const src = fs.readFileSync(path.join(__dirname, "../src/voice/commands.ts"), "utf8");
const { code } = esbuild.transformSync(src, { loader: "ts", format: "cjs", target: "es2020" });
const mod = { exports: {} };
new Function("module", "exports", code)(mod, mod.exports);
const { parseCommand } = mod.exports;

// the real tier-1 areas (graph.ts CLUSTER_SPECS)
const AREAS = [
  { id: "catalyzed", label: "Catalyzed Alpha" },
  { id: "finance", label: "Finance" },
  { id: "trading", label: "Trading Bot" },
  { id: "studio", label: "Studio" },
  { id: "praxis", label: "Praxis" },
  { id: "learn", label: "Learn the Stack" },
];

let pass = 0,
  fail = 0;
const subset = (got, exp) =>
  got && exp && Object.keys(exp).every((k) => JSON.stringify(got[k]) === JSON.stringify(exp[k]));
const ok = (cond, msg, extra = "") => {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    fail++;
    console.log("  ✗ " + msg + (extra ? `  — ${extra}` : ""));
  }
};

// [utterance, expected-intent-subset]
const cases = [
  // views
  ["open the journey", { kind: "view", view: "journey" }],
  ["show me the timeline", { kind: "view", view: "journey" }],
  ["take me to the brain", { kind: "view", view: "brain" }],
  ["switch the view", { kind: "view", view: "toggle" }],
  // brain model switching keeps the full qualified model name; the former
  // short regex captured only "gpt 5.6" and silently selected paid Sol.
  ["switch to gpt 5.6 terra", { kind: "brain-model", name: "gpt 5.6 terra" }],
  ["switch to gpt-5.6 luna model", { kind: "brain-model", name: "gpt-5.6 luna" }],
  ["switch to openai api luna", { kind: "brain-model", name: "openai api luna" }],
  ["use codex as the brain", { kind: "brain-model", name: "codex" }],
  // areas (need a lead verb or a bare area name)
  ["fly to Catalyzed", { kind: "area", areaId: "catalyzed" }],
  ["go to praxis", { kind: "area", areaId: "praxis" }],
  ["show me the trading bot", { kind: "area", areaId: "trading" }],
  ["jump to Learn the Stack", { kind: "area", areaId: "learn" }],
  // overview / escape
  ["overview", { kind: "overview" }],
  ["zoom out", { kind: "overview" }],
  ["go back", { kind: "overview" }],
  ["please go home", { kind: "overview" }],
  ["overview, please", { kind: "overview" }],
  // transport
  ["next", { kind: "transport", axis: "task", dir: 1 }],
  ["next task", { kind: "transport", axis: "task", dir: 1 }],
  ["previous milestone", { kind: "transport", axis: "task", dir: -1 }],
  ["forward in time", { kind: "transport", axis: "time", dir: 1 }],
  ["back in time", { kind: "transport", axis: "time", dir: -1 }],
  ["next lane", { kind: "transport", axis: "area", dir: 1 }],
  ["previous area", { kind: "transport", axis: "area", dir: -1 }],
  // open windows / tools
  ["open flight deck", { kind: "open", target: "flightdeck" }],
  ["open the command center", { kind: "open", target: "command" }],
  ["open the cockpit", { kind: "open", target: "command" }],
  ["move the command center window to my monitor's display", { kind: "window-placement", target: "command" }],
  // window placement - regression-critical: move must NOT re-open, open must NOT move
  ["move the command center to my other monitor", { kind: "window-placement", target: "command", placement: { kind: "next" } }],
  ["move main window to the other monitor", { kind: "window-placement", target: "main", placement: { kind: "next" } }],
  ["move home window to the right screen", { kind: "window-placement", target: "main", placement: { kind: "right" } }],
  ["move second brain to the other monitor", { kind: "window-placement", target: "knowledge", placement: { kind: "next" } }],
  ["open the command center", { kind: "open", target: "command" }],
  ["command center", { kind: "open", target: "command" }],
  ["put the flight deck on monitor 2", { kind: "window-placement", target: "flightdeck", placement: { kind: "index", n: 2 } }],
  ["move praxis to the left screen", { kind: "window-placement", target: "main", placement: { kind: "left" } }],
  ["move the command center to the right screen", { kind: "window-placement", target: "command", placement: { kind: "right" } }],
  ["put the memory galaxy on the third screen", { kind: "window-placement", target: "knowledge", placement: { kind: "index", n: 3 } }],
  ["bring it back to my main monitor", { kind: "window-placement", target: "main", placement: { kind: "primary" } }],
  ["open the memory galaxy", { kind: "open", target: "memory" }],
  ["show me the agent dashboard", { kind: "open", target: "memory" }],
  ["open the second brain", { kind: "open", target: "memory" }],
  ["open the planner", { kind: "open", target: "planner" }],
  ["new idea", { kind: "open", target: "dump" }],
  // close / hide / dismiss a window (deliverable A) - the bug: "close the command
  // center" had no matching verb and fell through to brain_chat (→ mojibake). It must
  // now parse to a real `close` intent for EVERY window and every dismiss phrasing.
  ["close the command center", { kind: "close", target: "command" }],
  ["hide the command center", { kind: "close", target: "command" }],
  ["dismiss the cockpit", { kind: "close", target: "command" }],
  ["get rid of the command center", { kind: "close", target: "command" }],
  ["minimize the command center", { kind: "close", target: "command" }],
  ["close the memory galaxy", { kind: "close", target: "knowledge" }],
  ["hide the memory galaxy", { kind: "close", target: "knowledge" }],
  ["get rid of the second brain", { kind: "close", target: "knowledge" }],
  ["dismiss the agent dashboard", { kind: "close", target: "knowledge" }],
  ["close the flight deck", { kind: "close", target: "flightdeck" }],
  ["hide flight deck", { kind: "close", target: "flightdeck" }],
  ["shut the mission control", { kind: "close", target: "flightdeck" }],
  ["close praxis", { kind: "close", target: "main" }],
  ["hide the brain", { kind: "close", target: "main" }],
  ["close the main window", { kind: "close", target: "main" }],
  // no window named → default to the brain (same convention as the move block)
  ["close it", { kind: "close", target: "main" }],
  ["close this window", { kind: "close", target: "main" }],
  ["close chrome if it is open", { kind: "ask" }],
  ["close firefox when it hangs", { kind: "ask" }],
  ["minimize chrome if it is noisy", { kind: "ask" }],
  // Ambiguous, unsupported-browser, global, and multi-action window commands
  // are zero-mutation local refusals. They must never default to closing Praxis.
  ["Close my browser, please.", { kind: "ask" }],
  ["Close my browser, please,", { kind: "ask" }],
  ["close my browser, thanks", { kind: "ask" }],
  ["close my browser for me", { kind: "ask" }],
  ["close the chrome window", { kind: "ask" }],
  ["minimize the firefox window", { kind: "ask" }],
  ["close safari", { kind: "ask" }],
  ["move chrome aside", { kind: "ask" }],
  ["hide my browser", { kind: "ask" }],
  ["close notepad", { kind: "ask" }],
  ["move obsidian to monitor 2", { kind: "ask" }],
  ["place chrome on monitor 2", { kind: "ask" }],
  ["close", { kind: "refuse" }],
  ["minimize", { kind: "refuse" }],
  ["move to monitor 2", { kind: "refuse" }],
  ["please close", { kind: "refuse" }],
  ["close please", { kind: "refuse" }],
  ["can you minimize", { kind: "refuse" }],
  ["move chrome to monitor 2 delete a file display", { kind: "ask" }],
  ["open foo close bar", { kind: "ask" }],
  // close must NOT re-open (the inverse of the move regression) and must NOT eat a
  // bare window name (that still OPENS) - guards for the open/close boundary
  ["command center", { kind: "open", target: "command" }],
  ["open the command center", { kind: "open", target: "command" }],
  ["show me the command center", { kind: "open", target: "command" }],
  ["pop open the command center", { kind: "open", target: "command" }],
  ["pull it up the command center", { kind: "open", target: "command" }],
  // A missing target is an honest local refusal, never a phantom close or Live handoff.
  // dismiss verbs must not hijack unrelated phrases lacking a window/pronoun
  ["hide and seek", { kind: "ask" }],
  ["move the meeting aside", { kind: "ask" }],
  ["bring the book to me", { kind: "ask" }],
  ["put the groceries away", { kind: "ask" }],
  ["I am open to switching approaches", { kind: "ask" }],
  ["the store is open and close to home", { kind: "ask" }],
  ["clear the cache", { kind: "ask" }],
  ["the overview looks good", { kind: "ask" }],
  ["I need an escape plan", { kind: "ask" }],
  ["we should go back tomorrow", { kind: "ask" }],
  // capture (preserves the thought's casing)
  ["remember to call the bank tomorrow", { kind: "capture", text: "to call the bank tomorrow" }],
  ["dump the trading idea about hedging", { kind: "capture", text: "the trading idea about hedging" }],
  ["Remember to Call Mom", { kind: "capture", text: "to Call Mom" }],
  // gesture
  ["gesture mode", { kind: "gesture", on: true }],
  ["control with my hands", { kind: "gesture", on: true }],
  ["stop gesture control", { kind: "gesture", on: false }],
  // status / help / sleep
  ["what are you working on", { kind: "status" }],
  ["what's running", { kind: "status" }],
  ["help", { kind: "help" }],
  ["go to sleep", { kind: "sleep" }],
  ["stop listening", { kind: "sleep" }],
  // bare "dismiss" (no window) still stands the mic down; "dismiss the <window>" closes it
  ["dismiss", { kind: "sleep" }],
  ["never mind", { kind: "sleep" }],
  // media transport is NOT journey transport - falls through as `ask` so the
  // voice router's native media-key rung gets it (audit finding #2)
  ["next track", { kind: "ask" }],
  ["next song", { kind: "ask" }],
  ["skip this track", { kind: "ask" }],
  ["pause the music", { kind: "ask" }],
  ["volume up", { kind: "ask" }],
  ["mute", { kind: "ask" }],
  // journey transport still owns the non-media words
  ["next", { kind: "transport", axis: "task", dir: 1 }],
  ["next task", { kind: "transport", axis: "task", dir: 1 }],
  // bare "main" is NOT a display reference (audit finding #13) - this is a VIEW
  ["bring up the main view", { kind: "view", view: "brain" }],
  // ...but "main monitor" still is one
  ["move praxis to the main monitor", { kind: "window-placement", target: "main", placement: { kind: "primary" } }],
  // quad formation may target a specific display; this used to parse the action
  // but drop the display hint, so Rust tiled the current screen anyway.
  ["open quad tile formation on a different display", { kind: "tile-quadrants", placement: { kind: "next" } }],
  ["tile the windows on monitor 2", { kind: "tile-quadrants", placement: { kind: "index", n: 2 } }],
  ["quad tile on the largest display", { kind: "tile-quadrants", placement: { kind: "largest" } }],
  ["tile the screens", { kind: "tile-quadrants" }],
  // run-skill - re-invoke a captured skill by name (EXPLICIT verb+handle only).
  // A trailing handle word (skill/routine/workflow/…) is STRIPPED off the name so
  // the intent carries the skill's identity, not the decoration.
  ["run my deploy routine", { kind: "run-skill", name: "deploy" }],
  ["run the deploy routine", { kind: "run-skill", name: "deploy" }],
  ["do the nightly build skill", { kind: "run-skill", name: "nightly build" }],
  ["run my catalyzed feed skill", { kind: "run-skill", name: "catalyzed feed" }],
  ["please run my morning workflow", { kind: "run-skill", name: "morning" }],
  // possessive form with NO trailing handle keeps the full spoken name
  ["run my catalyzed feed", { kind: "run-skill", name: "catalyzed feed" }],
  // run-skill GUARDS - bare "run" / incidental "running" must NOT match run-skill.
  // "run" alone falls through to journey/ask; "running late" is a plain question.
  ["run", { kind: "ask" }],
  ["running late", { kind: "ask" }],
  ["run to the store", { kind: "ask" }],
  // "run a report" has a verb but no skill HANDLE (my / skill / routine) → not run-skill
  ["run a report", { kind: "ask" }],
  // fallbacks - genuine questions stay questions (the important guards)
  ["what's next", { kind: "ask" }],
  ["what's the weather in Lisbon", { kind: "ask" }],
];

console.log("voice command router");
for (const [say, exp] of cases) {
  const cmd = parseCommand(say, AREAS);
  ok(subset(cmd && cmd.intent, exp), `"${say}" → ${exp.kind}${exp.view || exp.target || exp.axis ? ` (${exp.view || exp.target || exp.axis}${exp.dir ? " " + exp.dir : ""})` : ""}${exp.areaId ? ` ${exp.areaId}` : ""}`,
    cmd ? `got ${JSON.stringify(cmd.intent)}` : "got null");
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SEQUENCING CONTRACT
//
// These used to assert `refuse`.
//
// `null` from parseCommand does NOT mean "nothing happens". It means the regex
// grammar does not own this utterance, so it goes to the model path - which has
// real desktop tools (open_app, type_text, press_key, click, screenshot) and can
// order them. Refusing was the only outcome that actually did nothing.
// ─────────────────────────────────────────────────────────────────────────────
const SEQUENCED = [
  // Two faults, both fixed: conversational lead-ins ("okay", "so", "hey", "I want you to") were
  // never stripped, so the sequence detector - which needs the FIRST word to be an imperative
  // verb - never saw the instruction; and this grammar refused anything window-shaped it could
  // not do in ONE step, even when the window was named perfectly clearly. It declines now. Only
  // a command that names NO window at all ("close", "minimize", "move to monitor 2") still asks
  // which one - see the block below.
  "close bar open foo",
  "close browsers",
  "close chrome command center",
  "close command center delete a file",
  "close command center flight deck",
  "close foo delete a file",
  "close the window",
  "delete a file close chrome",
  "dismiss foo",
  "maximize foo",
  "move chrome to monitor 2 but move firefox to monitor 1",
  "move chrome to monitor 2 if it is free",
  "move chrome to monitor 2 or move firefox to monitor 1",
  "move command center to monitor 0",
  "move command center to monitor 2 delete a file display",
  "move command center to monitor 2 or move flight deck to monitor 1",
  "move command center to the largest display",
  "move my browser to the right display because it is crowded",
  "move the command center",
  "move the window to monitor 2",
  "move this window to screen #0",
  "open command center close chrome",
  "restore foo",
  "set trust to sovereign close chrome",
  "close all tabs",
  "close all windows and enter quad tile formation",
  "close all windows and set trust to sovereign",
  "close chrome & switch to live mode",
  "close chrome and search for cats",
  "close chrome and switch to live mode",
  "close chrome and use codex as the brain",
  "close chrome live mode",
  "close chrome plus switch to live mode",
  "close chrome set trust to sovereign",
  "close chrome switch to live mode",
  "close chrome then minimize edge",
  "close chrome while you switch to live mode",
  "close chrome, please delete a file",
  "close chrome, please switch to live mode",
  "close chrome. switch to live mode",
  "close chrome; maximize edge",
  "close command center or open flight deck",
  "close everything",
  "close my browser and delete a file",
  "focus chrome and delete a file",
  "focus chrome switch to live mode",
  "go do everything close chrome",
  "open chrome and search for cats",
  "open command center and close flight deck",
  "open foobar and set trust to sovereign",
  "open foobar and switch to live mode",
  "set trust to sovereign and close chrome",
  "set trust to sovereign and close foobar",
  "set trust to sovereign and open foobar",
  "switch to chrome and set trust to sovereign",
  "switch to live mode and close chrome",
  "switch to live mode and open foobar",
  "tile the windows and close chrome",
];
for (const say of SEQUENCED) {
  ok(parseCommand(say, AREAS) === null, `"${say}" → sequenced (handed to the model)`,
    JSON.stringify(parseCommand(say, AREAS)));
}

// ─────────────────────────────────────────────────────────────────────────────
// HOW PEOPLE ACTUALLY TALK
//
// `commandCore` stripped exactly five politeness forms (please / could you / can
// you / would you / will you) and nothing else, and it was called inside two
// guards rather than once at the top. So "okay", "so", "hey", "alright", "now",
// "I want you to" all survived, the sequence detector never saw an imperative
// first word, and the utterance fell through to a refusal.
//
// Nobody speaks in bare imperatives. Every phrase below refused before this fix.
// ─────────────────────────────────────────────────────────────────────────────
const LEAD_INS = [
  "Okay, I want you to open up Chrome and type in Port Perryweather",
  "okay I want you to open up chrome and type in port perryweather",
  "hey can you open chrome and search for cats",
  "could you please open chrome and type hello",
  "okay so can you just open chrome and search for cats",
  "alright now go to gmail and find the invoice",
];
for (const say of LEAD_INS) {
  const cmd = parseCommand(say, AREAS);
  const kind = cmd && cmd.intent ? cmd.intent.kind : "none";
  ok(kind !== "refuse", `"${say}" is not refused for how it starts`, `got ${kind}`);
}

// The lead-in is stripped, not merely tolerated: what remains must parse as the
// command it is. "Okay, close chrome" is exactly "close chrome".
for (const [lead, bare] of [
  ["Okay, close chrome.", "close chrome"],
  ["so open notepad", "open notepad"],
  ["hey minimize obsidian", "minimize obsidian"],
  ["I want you to open the command center", "open the command center"],
  ["can you minimize", "minimize"],
]) {
  const a = parseCommand(lead, AREAS);
  const b = parseCommand(bare, AREAS);
  // Compare the DECISION, not the transcript: an "ask" deliberately carries the
  // raw sentence through to the model, which should hear what the owner actually said.
  const decision = (c) => {
    if (!c || !c.intent) return "none";
    const { text, ...rest } = c.intent;
    return JSON.stringify(rest);
  };
  ok(decision(a) === decision(b),
    `"${lead}" decides the same as "${bare}"`,
    `${decision(a)} vs ${decision(b)}`);
}

// ...and a command that names NO window still asks which one, because there is
// genuinely nothing to resolve and no wider path can do better.
for (const say of ["close", "minimize", "move to monitor 2", "please close", "can you minimize"]) {
  const cmd = parseCommand(say, AREAS);
  ok(cmd && cmd.intent && cmd.intent.kind === "refuse",
    `"${say}" names no window, so it asks which one`,
    JSON.stringify(cmd && cmd.intent));
}

// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS BLOCK EXISTS FOR
//
// "set trust to sovereign and close foobar" returned a TRUST-CHANGE intent: the
// dial moved to IV · SOVEREIGN and the close never happened. A compound utterance
// could reconfigure Praxis as a side effect while dropping the thing actually
// asked for.
//
// It was never one bug. Measured across the whole grammar, five more settings
// moved the same way - the exec mode through four different conjunctions, and the
// brain model. Every one of them ran the SETTING half and discarded the DESKTOP
// half, which is the worst possible split.
//
// A setting may only change when changing it is the whole request.
// ─────────────────────────────────────────────────────────────────────────────
const MUTATING_KINDS = new Set(["trust", "exec-mode", "brain-model", "tile-quadrants", "halt"]);
const COMPOUNDS_THAT_MUST_NOT_MUTATE = [
  "set trust to sovereign and close foobar",
  "set trust to sovereign and close chrome",
  "set trust to sovereign close chrome",
  "set trust to sovereign and open foobar",
  "open foobar and set trust to sovereign",
  "close all windows and set trust to sovereign",
  "switch to chrome and set trust to sovereign",
  "go sovereign and open chrome",
  "trust level four and close edge",
  "close chrome. switch to live mode",
  "close chrome & switch to live mode",
  "close chrome plus switch to live mode",
  "close chrome while you switch to live mode",
  "close chrome and switch to live mode",
  "close chrome switch to live mode",
  "close chrome live mode",
  "close chrome and use codex as the brain",
  "tile the windows and close chrome",
  "close all windows and enter quad tile formation",
];
for (const say of COMPOUNDS_THAT_MUST_NOT_MUTATE) {
  const cmd = parseCommand(say, AREAS);
  const kind = cmd && cmd.intent ? cmd.intent.kind : "none";
  ok(!MUTATING_KINDS.has(kind), `"${say}" must not move a setting as a side effect`,
    `got ${kind}`);
}

// The other half of the same contract: a setting change that IS the whole request
// still works, including every detent name spoken on its own.
for (const [say, exp] of [
  ["set trust to sovereign", { kind: "trust", key: "full" }],
  ["go sovereign", { kind: "trust", key: "full" }],
  ["trust level four", { kind: "trust", key: "full" }],
  ["set trust to execute", { kind: "trust", key: "operator" }],
  ["observe mode", { kind: "trust", key: "observe" }],
  ["propose mode", { kind: "trust", key: "approve" }],
  ["execute mode", { kind: "trust", key: "operator" }],
  ["live mode", { kind: "exec-mode", mode: "live" }],
  ["hybrid mode", { kind: "exec-mode", mode: "hybrid" }],
  ["background mode", { kind: "exec-mode", mode: "background" }],
  ["use codex as the brain", { kind: "brain-model", name: "codex" }],
]) {
  const cmd = parseCommand(say, AREAS);
  ok(subset(cmd && cmd.intent, exp), `"${say}" → ${exp.kind} ${exp.key || exp.mode || exp.name}`,
    cmd ? `got ${JSON.stringify(cmd.intent)}` : "got null");
}

// empty input → null (nothing to do)
ok(parseCommand("", AREAS) === null, `empty utterance → null`);

async function testAppOperations() {
  const assert = require("assert/strict");
  const operationCases = require("./voice-operation-cases.cjs");
  const calls = [];
  const events = [];
  const settings = [];
  const speech = [];
  const catalog = [
    { key: "quill", name: "Quill", options: [{ id: "grok-4.7-fast", label: "Grok 4.7" }] },
    { key: "vega", name: "Vega", options: [{ id: "gpt-6-astra", label: "GPT-6 Astra" }] },
    { key: "forge", name: "Forge", options: [{ id: "opus", label: "Claude Opus 5.5" }] },
    { key: "sage", name: "Sage", options: [{ id: "fable-runtime-id", label: "Fable" }] },
    { key: "lens", name: "Lens", options: [{ id: "vision", label: "Vision" }] },
    { key: "atlas", name: "Atlas", options: [{ id: "sonnet", label: "Sonnet" }] },
    { key: "scribe", name: "Scribe", options: [{ id: "sonnet", label: "Sonnet" }] },
  ];
  const row = (window, label, used, limit, basis = "real", extra = {}) => ({ window, label, used, limit, basis, ...extra });
  let summary = [
    { key: "codex", plan: [row("5h", "Codex Plus 5h", 31, 100), row("weekly", "Codex weekly", 16, 100)] },
    { key: "cursor", plan: [row("monthly", "Cursor Models", 0, 100)] },
    { key: "claude", plan: [row("refused", "refused", 0, 0), row("5h", "stale estimate", 9, 10, "estimated")] },
  ];
  let failCommand;
  let emitError = false;
  let beforeInvoke = () => {};
  let snapshots = [];
  let graph = JSON.stringify({ nodes: [{}, {}, {}], edges: [{}, {}] });
  const state = { agents: { forge: { name: "Forge", status: "working" }, vega: { name: "Vega", status: "idle" } }, setVoiceOn: () => {} };
  const invoke = async (command) => {
    calls.push(command);
    beforeInvoke(command);
    if (command === failCommand) throw new Error("backend unavailable");
    if (command === "usage_summary") return summary;
    if (command === "fd_sessions") return snapshots.shift() ?? { generatedAt: Date.now() + 1, activeCount: 8, runningCount: 3 };
    if (command === "read_memory_graph") return graph;
    return undefined;
  };
  const imports = {
    "@tauri-apps/api/core": { invoke },
    "@tauri-apps/api/event": { emit: async (event) => { if (emitError) throw new Error("event bus down"); events.push(event); } },
    "@/store/usePraxisStore": { usePraxisStore: { getState: () => state } },
    "@/data/graph": { buildGraph: () => ({ nodes: [], byId: new Map() }) },
    "@/data/eventBus": { eventBus: { emit: () => {} } },
    "./speak": { speak: (text) => speech.push(text), cancelSpeech: () => speech.push("cancel") },
    "@/command/controlStore": { setToolEnabled: (...args) => settings.push(args), setExecMode: () => {} },
    "@/command/fleetStore": { FLEET_AGENTS: catalog, setFleetModel: (...args) => { settings.push(args); return true; } },
    "@/command/haltStore": { setHalted: () => {} },
    "@/command/brainStore": {},
    "@/orchestrator/ownedRuns": {},
  };
  const compiled = esbuild.transformSync(fs.readFileSync(path.join(__dirname, "../src/voice/execute.ts"), "utf8"), {
    loader: "ts", format: "cjs", target: "es2020", supported: { "dynamic-import": false },
  }).code;
  const execution = { exports: {} };
  new Function("module", "exports", "require", compiled)(execution, execution.exports, (name) => {
    if (!(name in imports)) throw new Error(`unexpected import: ${name}`);
    return imports[name];
  });
  const { executeVoiceCommand, executeAndSpeak } = execution.exports;
  global.window = { __TAURI_INTERNALS__: {} };
  const reset = () => { calls.length = 0; events.length = 0; settings.length = 0; speech.length = 0; };
  for (const [phrase, expected] of operationCases) {
    reset();
    const cmd = parseCommand(phrase, AREAS);
    assert.deepEqual(cmd?.intent, expected, phrase);
    const { reply } = await executeVoiceCommand(cmd);
    if (expected.kind === "refresh-usage") {
      assert.deepEqual(calls, ["refresh_live_state", "usage_summary"]);
      assert.deepEqual(events, ["praxis://usage-refresh"]);
      assert.match(reply, /Codex: 5h 31%, weekly 16%; Cursor: Cursor Models 0%; Claude: The vendor is refusing Claude Code/);
      assert.doesNotMatch(reply, /stale estimate|90%/);
    } else if (expected.kind === "refresh-flightdeck") {
      assert.deepEqual(calls, ["refresh_live_state", "fd_sessions"]);
      assert.equal(reply, "Flight Deck refreshed — 8 active, 3 running");
    } else if (expected.kind === "refresh-memory") {
      assert.deepEqual(calls, ["refresh_memory_graph", "read_memory_graph"]);
      assert.deepEqual(events, ["praxis://memory-refresh"]);
      assert.equal(reply, "Memory Galaxy rebuild requested — currently 3 nodes, 2 links");
    } else if (expected.kind === "fleet-model") {
      const agent = catalog.find((a) => a.key === expected.agent);
      assert.deepEqual(settings, [[agent.key, agent.options[0].id]]);
      assert.match(reply, /model set to/);
      assert.deepEqual(calls, []);
    } else {
      assert.deepEqual(settings, [[expected.key, expected.enabled]]);
      assert.match(reply, expected.enabled ? /on — enabled/ : /off — disabled/);
    }
    ok(true, `parse + execute: ${phrase}`);
  }
  reset();
  const status = await executeVoiceCommand(parseCommand("status"));
  assert.match(status.reply, /^1 agent working: Forge/);
  assert.match(status.reply, /5h 31%/);
  state.agents = {};
  assert.match((await executeVoiceCommand(parseCommand("status"))).reply, /^0 agents working.*5h 31%/);
  ok(true, "status includes live rails for both working and idle fleets");

  summary = [{ key: "claude", plan: [row("paused", "paused", 0, 0, "real", { resets_at: 1792000000000 }), row("5h", "5h", 1, 4, "estimated"), row("weekly", "weekly", 2, 4, "learned")] }];
  const paused = (await executeVoiceCommand(parseCommand("refresh usage"))).reply;
  // Reset times read short: "3:10 PM" today, or "Fri 10/16 3:10 PM" on another day.
  const at = new Date(1792000000000);
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  assert.ok(paused.includes(time) && !paused.includes(at.toLocaleString()), paused);
  assert.match(paused, /live meter paused until/);
  assert.match(paused, /25% \(estimated\)/);
  assert.match(paused, /50% \(learned\)/);
  summary = [{ key: "codex", plan: [row("5h", "5h", 0, 0)] }];
  assert.match((await executeVoiceCommand(parseCommand("refresh usage"))).reply, /5h unavailable/);
  summary = [];
  assert.match((await executeVoiceCommand(parseCommand("refresh usage"))).reply, /no plan meters available/);
  ok(true, "paused reset time, estimated/learned limits, absent limits and empty meters stay truthful");

  reset();
  await executeVoiceCommand(parseCommand("set Qui to grok-4.7-fast"));
  assert.deepEqual(settings, [["quill", "grok-4.7-fast"]]);
  reset();
  await executeVoiceCommand(parseCommand("set Quill to nonexistent"));
  assert.deepEqual(settings, []);
  assert.match((await executeVoiceCommand(parseCommand("set Quill to nonexistent"))).reply, /Grok 4.7/);
  assert.match((await executeVoiceCommand(parseCommand("set Nobody's model to Sonnet"))).reply, /Unknown or ambiguous agent/);
  catalog[0].options.push({ id: "grok-4.7-other", label: "Grok 4.7 Other" });
  assert.match((await executeVoiceCommand(parseCommand("set Quill to Grok"))).reply, /valid models/);
  assert.deepEqual(settings, []);
  catalog[0].options = [{ id: "future-model-id", label: "Future Model 9.9" }];
  await executeVoiceCommand(parseCommand("set Quill to Future Model 9.9"));
  assert.deepEqual(settings, [["quill", "future-model-id"]]);
  ok(true, "agent/model matching uses live labels and IDs; unknown and ambiguous names do not mutate");

  for (const phrase of ["put Chrome on monitor 2", "put Praxis on monitor 2", "use memory for research", "set Quill to Grok 4.7 and close Chrome", "turn off Cursor and refresh usage", "don't turn off Cursor"])
    assert.ok(!["fleet-model", "tool-breaker", "refresh-usage"].includes(parseCommand(phrase)?.intent.kind), phrase);
  ok(true, "ordinary desktop commands, compounds and negations never reconfigure the fleet");

  reset();
  snapshots = [{ generatedAt: 1, activeCount: 99, runningCount: 99 }];
  assert.match((await executeVoiceCommand(parseCommand("refresh agents"))).reply, /8 active, 3 running/);
  assert.equal(calls.filter((c) => c === "fd_sessions").length, 2);
  snapshots = [{ generatedAt: Date.now(), activeCount: 0, runningCount: 0, error: "snapshot thread panicked" }];
  assert.match((await executeVoiceCommand(parseCommand("refresh agents"))).reply, /failed: snapshot thread panicked/);
  ok(true, "Flight Deck waits past a stale snapshot and reports snapshot errors");

  graph = null;
  assert.match((await executeVoiceCommand(parseCommand("refresh memory galaxy"))).reply, /no graph available yet/);
  graph = "{}";
  assert.match((await executeVoiceCommand(parseCommand("refresh memory galaxy"))).reply, /failed: invalid memory graph/);
  for (const [phrase, command] of [["refresh usage", "refresh_live_state"], ["refresh usage", "usage_summary"], ["refresh agents", "fd_sessions"], ["refresh memory galaxy", "refresh_memory_graph"], ["refresh memory galaxy", "read_memory_graph"]]) {
    failCommand = command;
    assert.match((await executeVoiceCommand(parseCommand(phrase))).reply, /failed: backend unavailable/);
  }
  failCommand = "usage_summary";
  assert.match((await executeVoiceCommand(parseCommand("status"))).reply, /0 agents working.*Usage unavailable/);
  failCommand = undefined;
  emitError = true;
  assert.match((await executeVoiceCommand(parseCommand("refresh usage"))).reply, /window refresh broadcast failed/);
  emitError = false;
  ok(true, "missing/malformed graphs, failed backend calls and failed broadcasts never claim success");

  reset();
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await executeVoiceCommand(parseCommand("refresh usage"), aborted.signal)).reply, "Stopped.");
  assert.deepEqual(calls, []);
  const midway = new AbortController();
  beforeInvoke = () => midway.abort();
  assert.equal((await executeVoiceCommand(parseCommand("refresh usage"), midway.signal)).reply, "Stopped.");
  assert.deepEqual(events, []);
  beforeInvoke = () => {};
  reset();
  const silent = await executeAndSpeak(parseCommand("refresh usage"), undefined, undefined, { speak: false });
  assert.match(silent.reply, /Usage reloaded/);
  assert.deepEqual(speech, []);
  await executeAndSpeak(parseCommand("status"));
  assert.equal(speech[0], "cancel");
  assert.match(speech[1], /0 agents working/);
  ok(true, "abort stops follow-up effects; silent execution avoids TTS and cancellation; default still speaks");

  reset();
  global.window = {};
  for (const phrase of ["refresh usage", "refresh agents", "refresh memory galaxy"])
    assert.match((await executeVoiceCommand(parseCommand(phrase))).reply, /only works in the Praxis desktop app/);
  assert.deepEqual(calls, []);
  ok(true, "browser fallback never invokes desktop-only refresh commands");
  await require("./test-command-refresh-listeners.cjs")();
  ok(true, "Supply and Galaxy listeners refresh all windows, observe asynchronous writes, never re-emit, and clean up");
}

testAppOperations().catch((err) => {
  ok(false, "app operation execution tests", err.stack);
}).finally(() => {
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
});
