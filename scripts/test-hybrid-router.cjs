/**
 * test-hybrid-router - headless logic test for the Hybrid Jarvis fast router's PURE
 * classification layer (src/voice/hybridClassify.ts):
 *   • classifyLocal(raw) - zero-latency local pre-classify: halt / type / press /
 *                           scroll / todo / unknown
 *   • parseClassify(raw) - parse the fast brain's classify reply into a bucket
 *
 * Same pattern as test-voice-commands.cjs: transpile the TS on the fly with esbuild
 * (already a dep via vite), no React/Tauri/DOM touched. Run:
 *   node scripts/test-hybrid-router.cjs
 */
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const src = fs.readFileSync(path.join(__dirname, "../src/voice/hybridClassify.ts"), "utf8");
const { code } = esbuild.transformSync(src, { loader: "ts", format: "cjs", target: "es2020" });
const mod = { exports: {} };
new Function("module", "exports", code)(mod, mod.exports);
const { classifyLocal, parseClassify, requiresSubmitConfirmation, isImperativeBuildGoal } = mod.exports;

const policySrc = fs.readFileSync(path.join(__dirname, "../src/voice/operatorPolicyCore.ts"), "utf8");
const { code: policyCode } = esbuild.transformSync(policySrc, { loader: "ts", format: "cjs", target: "es2020" });

/**
 * Resolve the project's `@/` alias for a module compiled in this harness.
 *
 * operatorPolicyCore stopped being self-contained when the trust ladder moved into
 * `@/shared/autonomyPolicy` - one module for the dial instead of a threshold
 * inlined at each gate. Without this, the harness died on `require is not defined`
 * before a single assertion ran, which reads exactly like a passing suite if you
 * only look at the exit line.
 */
const aliasCache = new Map();
function aliasRequire(spec) {
  if (!spec.startsWith("@/")) return require(spec);
  if (aliasCache.has(spec)) return aliasCache.get(spec);
  const file = path.join(__dirname, "../src", spec.slice(2) + ".ts");
  const compiled = esbuild.transformSync(fs.readFileSync(file, "utf8"), {
    loader: "ts",
    format: "cjs",
    target: "es2020",
  }).code;
  const m = { exports: {} };
  aliasCache.set(spec, m.exports);
  new Function("module", "exports", "require", compiled)(m, m.exports, aliasRequire);
  aliasCache.set(spec, m.exports);
  return m.exports;
}

const policyMod = { exports: {} };
new Function("module", "exports", "require", policyCode)(policyMod, policyMod.exports, aliasRequire);
const { evaluateOperatorPolicy, operatorApprovalRequired, voiceCommandNeedsDesktop } = policyMod.exports;
const routerSrc = fs.readFileSync(path.join(__dirname, "../src/voice/hybridRouter.ts"), "utf8");
const realtimeSrc = fs.readFileSync(path.join(__dirname, "../src/voice/realtimeTransport.ts"), "utf8");
const hybridToolsSrc = fs.readFileSync(path.join(__dirname, "../src/voice/hybridTools.ts"), "utf8");
const realtimePromptSrc = fs.readFileSync(path.join(__dirname, "../src/voice/realtimePrompt.ts"), "utf8");
const hybridSessionHookSrc = fs.readFileSync(path.join(__dirname, "../src/voice/useHybridSession.ts"), "utf8");
const hybridSessionPanelSrc = fs.readFileSync(path.join(__dirname, "../src/voice/HybridSession.tsx"), "utf8");
const routeSrc = fs.readFileSync(path.join(__dirname, "../src/voice/route.ts"), "utf8");
const typeTextStart = hybridToolsSrc.indexOf('name: "type_text"');
const pressKeyStart = hybridToolsSrc.indexOf('name: "press_key"');
const scrollStart = hybridToolsSrc.indexOf('name: "scroll"');
const typeTextSpec = typeTextStart >= 0 && pressKeyStart > typeTextStart
  ? hybridToolsSrc.slice(typeTextStart, pressKeyStart)
  : "";
const pressKeySpec = pressKeyStart >= 0 && scrollStart > pressKeyStart
  ? hybridToolsSrc.slice(pressKeyStart, scrollStart)
  : "";
const executeSrc = fs.readFileSync(path.join(__dirname, "../src/voice/execute.ts"), "utf8");
const respondSrc = fs.readFileSync(path.join(__dirname, "../src/orchestrator/respond.ts"), "utf8");
const orchestratorSrc = fs.readFileSync(path.join(__dirname, "../src/orchestrator/orchestrator.ts"), "utf8");
const unattendedSrc = fs.readFileSync(path.join(__dirname, "../src/orchestrator/unattended.ts"), "utf8");
const computerUseRustSrc = fs.readFileSync(path.join(__dirname, "../src-tauri/src/computer_use.rs"), "utf8");
const sovereignRustSrc = fs.readFileSync(path.join(__dirname, "../src-tauri/src/sovereign.rs"), "utf8");
const nativeOpsRustSrc = fs.readFileSync(path.join(__dirname, "../src-tauri/src/native_ops.rs"), "utf8");
const stopRunsSrc = fs.readFileSync(path.join(__dirname, "../src/voice/stopOperatorRuns.ts"), "utf8");
const { code: stopRunsCode } = esbuild.transformSync(stopRunsSrc, { loader: "ts", format: "cjs", target: "es2020" });
const stopRunsMod = { exports: {} };
new Function("module", "exports", "require", stopRunsCode)(stopRunsMod, stopRunsMod.exports, require);
const {
  createOperatorTurnEpoch,
  getUnresolvedOperatorOwners,
  registerAsyncCleanup,
  releaseUnresolvedOperatorOwners,
  retainUnresolvedOperatorOwners,
  SerializedOperatorStopQueue,
  settleOperatorStopLanes,
  stopOperatorSessionRuns,
  waitForCurrentOperatorTurn,
} = stopRunsMod.exports;

const ownedRunsSrc = fs.readFileSync(path.join(__dirname, "../src/orchestrator/ownedRuns.ts"), "utf8");
const { code: ownedRunsCode } = esbuild.transformSync(ownedRunsSrc, { loader: "ts", format: "cjs", target: "es2020" });
const ownedRunsMod = { exports: {} };
new Function("module", "exports", ownedRunsCode)(ownedRunsMod, ownedRunsMod.exports);
const {
  ownedOrchestrationCount,
  startOwnedOrchestration,
  stopOwnedOrchestration,
} = ownedRunsMod.exports;

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

for (const s of [
  "Create a personal website — you choose the content, you have memory — using Vega, Quill and Forge. Then open it in a browser and maximize it on my screen.",
  "build me a landing page for the recital",
  "Atlas, can you create a small game about orbits",
  "please fix the flight deck session count",
  "make me a personal website with my projects",
  "design a portfolio site for my trading research",
]) {
  ok(isImperativeBuildGoal(s) === true, `imperative build → straight to Praxis: "${s.slice(0, 48)}"`);
}
for (const s of [
  "how's the build going?",
  "can you create a website?",
  "make me a coffee",
  "set up a meeting with Sam tomorrow",
  "I was thinking we should build something someday",
  "fix it",
  "remind me to build the deck tomorrow",
  "what should I create next",
]) {
  ok(isImperativeBuildGoal(s) === false, `not an imperative build → classifier decides: "${s}"`);
}

// ── classifyLocal - [utterance, expected-subset] ──────────────────────────────
const localCases = [
  // HALT - bare stop phrases only
  ["stop", { kind: "halt" }],
  ["cancel", { kind: "halt" }],
  ["never mind", { kind: "halt" }],
  ["nevermind", { kind: "halt" }],
  ["wait", { kind: "halt" }],
  ["hold on", { kind: "halt" }],
  ["praxis stop", { kind: "halt" }],
  ["that's enough", { kind: "halt" }],
  // "stop the music" carries an object → NOT a halt (media op handled elsewhere)
  ["stop the music", { kind: "unknown" }],
  ["cancel my subscription", { kind: "unknown" }],

  // TYPE - marker form keeps casing
  ["type this: Hello World", { kind: "type", text: "Hello World" }],
  ["type the following: dear team,", { kind: "type", text: "dear team," }],
  ["type hello there", { kind: "type", text: "hello there" }],
  ["write good morning everyone", { kind: "type", text: "good morning everyone" }],
  // bare "type" with no payload → not a type op
  ["type", { kind: "unknown" }],

  // PRESS
  ["press enter", { kind: "press", key: "enter" }],
  ["confirm press enter", { kind: "press", key: "enter", confirmed: true }],
  ["press return", { kind: "press", key: "return" }],
  ["confirm press return", { kind: "press", key: "return", confirmed: true }],
  ["press submit", { kind: "press", key: "submit" }],
  ["hit tab", { kind: "press", key: "tab" }],
  ["press the escape key", { kind: "press", key: "escape" }],
  ["press arrow down", { kind: "press", key: "arrow down" }],
  // press with a sentence payload (too long to be a key) → not a press
  ["press on with the plan and don't stop now", { kind: "unknown" }],

  // SCROLL
  ["scroll down", { kind: "scroll", direction: "down" }],
  ["scroll up", { kind: "scroll", direction: "up" }],
  ["scroll down 5", { kind: "scroll", direction: "down", amount: 5 }],
  ["scroll down three", { kind: "scroll", direction: "down", amount: 3 }],

  // TODO - explicit task-capture phrasing
  ["remind me to call the dentist", { kind: "todo", text: "call the dentist" }],
  ["add a to-do to review the PR", { kind: "todo", text: "review the PR" }],
  ["note that the API key expires friday", { kind: "todo", text: "the API key expires friday" }],
  ["todo: ship the hybrid feature", { kind: "todo", text: "ship the hybrid feature" }],
  ["I need to email Sarah back", { kind: "todo", text: "email Sarah back" }],
  ["don't let me forget to water the plants", { kind: "todo", text: "water the plants" }],
  ["I need to type up my notes", { kind: "todo", text: "type up my notes" }],

  // UNKNOWN - questions / build goals fall through to the brain classify
  ["what's the weather in Lisbon", { kind: "unknown" }],
  ["build me a landing page", { kind: "unknown" }],
  ["open chrome", { kind: "unknown" }],

  // UNATTENDED - the "go do everything" family (canonical phrases + variants),
  // matched BEFORE type/press/scroll/todo so it can never be misread as a
  // direct-input primitive or a to-do capture.
  ["go do everything", { kind: "unattended" }],
  ["just handle everything", { kind: "unattended" }],
  ["do everything you can", { kind: "unattended" }],
  ["run everything", { kind: "unattended" }],
  ["work through everything", { kind: "unattended" }],
  ["handle it all", { kind: "unattended" }],
  ["praxis, go do everything for me tonight", { kind: "unattended" }],
  ["clear the whole backlog", { kind: "unattended" }],
  ["clear the whole to-do list", { kind: "unattended" }],
  ["take care of everything", { kind: "unattended" }],
  // must NOT match ordinary commands with an object that isn't "everything/it all"
  ["run the build", { kind: "unknown" }],
  ["handle the deploy", { kind: "unknown" }],
  ["do the dishes", { kind: "unknown" }],
];

console.log("hybrid local classify");
for (const [say, exp] of localCases) {
  const got = classifyLocal(say);
  ok(subset(got, exp), `"${say}" → ${exp.kind}`, got ? `got ${JSON.stringify(got)}` : "got null");
}

// ── parseClassify - [reply, expected-subset] ──────────────────────────────────
const parseCases = [
  ['{"class":"ANSWER","payload":"It is sunny."}', { class: "ANSWER", payload: "It is sunny." }],
  ['{"class":"QUICK_ACTION","payload":"open chrome"}', { class: "QUICK_ACTION", payload: "open chrome" }],
  ['{"class":"TODO","payload":"buy milk"}', { class: "TODO", payload: "buy milk" }],
  ['{"class":"ESCALATE","payload":"build a react app"}', { class: "ESCALATE", payload: "build a react app" }],
  // UNATTENDED - the brain-classify fallback for paraphrases the local regex misses
  ['{"class":"UNATTENDED","payload":""}', { class: "UNATTENDED", payload: "" }],
  ['{"class":"UNATTENDED","payload":"focus on Praxis"}', { class: "UNATTENDED", payload: "focus on Praxis" }],
  // fenced JSON
  ['```json\n{"class":"ANSWER","payload":"hi"}\n```', { class: "ANSWER", payload: "hi" }],
  // loose fallback: leading class token
  ["ANSWER: The sky is blue.", { class: "ANSWER", payload: "The sky is blue." }],
  ["ESCALATE build the thing", { class: "ESCALATE", payload: "build the thing" }],
  ["UNATTENDED clear my whole backlog tonight", { class: "UNATTENDED", payload: "clear my whole backlog tonight" }],
  // lowercase class normalized
  ['{"class":"answer","payload":"yes"}', { class: "ANSWER", payload: "yes" }],
];

console.log("\nhybrid brain classify parse");
for (const [reply, exp] of parseCases) {
  const got = parseClassify(reply);
  ok(subset(got, exp), `${JSON.stringify(reply).slice(0, 46)} → ${exp.class}`, got ? `got ${JSON.stringify(got)}` : "got null");
}
// unparseable → null (caller falls back to speaking raw)
ok(parseClassify("") === null, "empty reply → null");
ok(parseClassify("total gibberish with no class token") === null, "no class token → null");
ok(requiresSubmitConfirmation("enter"), "enter requires explicit submit confirmation");
ok(requiresSubmitConfirmation("RETURN"), "return alias requires explicit submit confirmation");
ok(requiresSubmitConfirmation(" submit "), "submit alias requires explicit submit confirmation");
ok(!requiresSubmitConfirmation("tab"), "non-submission keys do not require submit confirmation");

console.log("\noperator policy — two surfaces, opposite rules");

// A live action and an unattended one differ ONLY by `origin`. Everything else in
// these two objects is identical, which is the point: the same instruction is
// ungated when the owner is watching and governed by the dial when he is not.
const live = {
  origin: "live",
  capability: "direct-input",
  text: "type hello",
  halted: false,
  execMode: "hybrid",
  toolEnabled: true,
  autonomy: "operator",
  sensitive: false,
  desktopAvailable: true,
};
const unattended = { ...live, origin: "unattended" };

// ── LIVE: no policy gates at all ────────────────────────────────────────────
ok(evaluateOperatorPolicy(live) === null, "a live action passes");
for (const autonomy of ["observe", "suggest", "approve", "operator", "full"]) {
  ok(
    evaluateOperatorPolicy({ ...live, autonomy }) === null,
    `live is ungated at autonomy "${autonomy}"`,
    evaluateOperatorPolicy({ ...live, autonomy }) || "",
  );
}
ok(
  evaluateOperatorPolicy({ ...live, sensitive: true }) === null,
  "live is ungated for a sensitive goal — 'type: delete the second row' used to be refused at every level",
);
ok(
  evaluateOperatorPolicy({ ...live, execMode: "background" }) === null,
  "exec mode does not gate a live action",
);
ok(
  !operatorApprovalRequired("live", "approve", true),
  "a live action never needs step approval",
);

// ── the owner's own switches: BOTH surfaces, every level ─────────────────────────
for (const surface of [live, unattended]) {
  ok(/halted/i.test(evaluateOperatorPolicy({ ...surface, halted: true }) || ""),
    `HALT blocks ${surface.origin} actions`);
  ok(/off/.test(evaluateOperatorPolicy({ ...surface, toolEnabled: false }) || ""),
    `the Computer Use breaker blocks ${surface.origin} actions`);
  ok(/desktop app/.test(evaluateOperatorPolicy({ ...surface, desktopAvailable: false }) || ""),
    `no shell is an honest miss for ${surface.origin} actions`);
}

// ── UNATTENDED: the dial, and only the dial ─────────────────────────────────
ok(/OBSERVE/.test(evaluateOperatorPolicy({ ...unattended, autonomy: "observe" }) || ""),
  "I · OBSERVE blocks unattended actuation");
ok(/Suggest/.test(evaluateOperatorPolicy({ ...unattended, autonomy: "suggest" }) || ""),
  "suggest blocks unattended actuation, with its OWN reason (the rungs are distinguishable)");
ok(evaluateOperatorPolicy({ ...unattended, autonomy: "approve" }) === null,
  "II · PROPOSE acts — it asks, it does not block");
ok(operatorApprovalRequired("unattended", "approve", false),
  "II · PROPOSE asks before EVERY step, sensitive or not");
ok(operatorApprovalRequired("unattended", "operator", true),
  "III · EXECUTE asks at a sensitive step");
ok(!operatorApprovalRequired("unattended", "operator", false),
  "III · EXECUTE runs ordinary work unattended");
ok(evaluateOperatorPolicy({ ...unattended, autonomy: "full", sensitive: true }) === null &&
   !operatorApprovalRequired("unattended", "full", true),
  "IV · SOVEREIGN clears everything, including a sensitive step, with no prompt");

// The four detents must be four OBSERVABLY different unattended behaviours -
// before this change `observe`, `suggest` and `approve` were byte-identical.
const shape = (autonomy) => JSON.stringify([
  evaluateOperatorPolicy({ ...unattended, autonomy }) === null,
  operatorApprovalRequired("unattended", autonomy, false),
  operatorApprovalRequired("unattended", autonomy, true),
]);
const detents = ["observe", "approve", "operator", "full"];
for (let a = 0; a < detents.length; a++) {
  for (let b = a + 1; b < detents.length; b++) {
    ok(shape(detents[a]) !== shape(detents[b]),
      `${detents[a]} and ${detents[b]} behave differently`);
  }
}

// Exec mode is the ROUTING fact for the visible-Codex lane, for BOTH origins.
ok(/Live/.test(evaluateOperatorPolicy({ ...unattended, capability: "visible" }) || ""),
  "an unattended visible-Codex handoff still needs Live mode");
for (const execMode of ["hybrid", "background"]) {
  ok(/Live mode/.test(evaluateOperatorPolicy({ ...live, capability: "visible", execMode }) || ""),
    `a spoken goal never reaches the Codex hand-off in ${execMode} mode`);
}
ok(evaluateOperatorPolicy({ ...live, capability: "visible", execMode: "live" }) === null,
  "Live mode is the one place a spoken goal may go to visible Codex");
for (const capability of ["native", "direct-input"]) {
  ok(evaluateOperatorPolicy({ ...live, capability, execMode: "hybrid" }) === null,
    `Praxis's own ${capability} tools stay ungated in HYBRID`);
}

// One record per spoken exchange (2026-09-15: a local-lane answer landed four lines
// in the Atlas panel - ask() wrote "typed" copies of both halves, then the router
// wrote the "voice" pair). Voice callers own their transcript.
ok(/ask\(utterance,\s*\{[^}]*transcript:\s*"caller"/.test(routerSrc),
  "the voice router's answer path tells ask() it records the exchange itself");
ok(/s\.ask\(intent\.text,\s*\{[^}]*transcript:\s*"caller"/.test(executeSrc),
  "the voice command ask path tells ask() it records the exchange itself");
// Every voice entry runs the one session; nothing mounts the old single-shot recorder.
const voicePopupSrc = fs.readFileSync(path.join(__dirname, "../src/voice/VoicePopup.tsx"), "utf8");
const hudSrc = fs.readFileSync(path.join(__dirname, "../src/components/Hud.tsx"), "utf8");
ok(!/useBrainMic|routeVoiceTranscript/.test(voicePopupSrc) && !/useBrainMic/.test(hudSrc),
  "Ctrl+T and hold T no longer run their own recorder into route.ts");
ok(/<HybridSession[\s\S]{0,200}mode=\{session\.mode\}/.test(voicePopupSrc),
  "VoicePopup mounts the one HybridSession for every entry, with its mode");
const speechStartedCase = realtimeSrc.match(/case "input_audio_buffer\.speech_started":([\s\S]{0,900}?)break;/m)?.[1] || "";
ok(/toolAbort\?\.abort\(\)/.test(speechStartedCase), "Realtime barge-in aborts the current tool turn");
ok(!/stopOperatorRuns\(\)/.test(speechStartedCase), "Realtime barge-in never triggers global operator stop");
ok(/name:\s*"halt"/.test(hybridToolsSrc), "Realtime advertises a dedicated halt tool");
ok(/case\s+"halt":\s*\n\s*return\s+"stop"/.test(hybridToolsSrc), "Realtime halt tool maps deterministically to local stop");
ok(
  typeTextSpec.includes("target_window") && typeTextSpec.includes("address_bar") &&
    /hybridType\(text, targetWindow, targetField\)/.test(hybridToolsSrc),
  "Realtime type_text binds an optional target and routes explicit browser address-bar typing",
);
ok(
  pressKeySpec.includes("target_window") && /hybridPress\(key, "live", targetWindow\)/.test(hybridToolsSrc),
  "Realtime press_key binds its optional target without changing the live action origin",
);
ok(
  realtimePromptSrc.includes("target_field set to address_bar") && realtimePromptSrc.includes("does not press Enter"),
  "Realtime prompt names address-bar routing and preserves explicit Enter control",
);
for (const verb of ["minimize", "maximize", "restore"]) {
  ok(hybridToolsSrc.includes(verb) && realtimePromptSrc.includes(verb), `Realtime advertises browser ${verb}`);
}
for (const kind of ["open", "close", "window-placement", "tile-quadrants", "exit-formation"]) {
  ok(voiceCommandNeedsDesktop(kind), `${kind} voice command uses desktop policy`);
}
ok(!voiceCommandNeedsDesktop("status"), "read-only status stays available without desktop control");

console.log("\nhybrid session lifecycle");
let controllerAborted = false;
let stoppedSessionOwners = [];
const teardownPromise = stopOperatorSessionRuns(
  {
    abort: () => {
      controllerAborted = true;
    },
  },
  " hybrid:pending ",
  ["hybrid:detached", "hybrid:pending", "", " hybrid:detached "],
  async (owners) => {
    stoppedSessionOwners = [...owners];
    return {
      orchestration: "requested",
      unattended: "requested",
      computerUse: "requested",
      sovereign: "requested",
      native: "requested",
      terminal: true,
    };
  },
);
ok(controllerAborted, "session teardown aborts the active router controller");
ok(
  JSON.stringify(stoppedSessionOwners) === JSON.stringify(["hybrid:pending", "hybrid:detached"]),
  "session teardown stops every unique pending/detached owner",
  `got ${JSON.stringify(stoppedSessionOwners)}`,
);
ok(teardownPromise instanceof Promise, "session teardown returns the scoped stop request");
ok(
  /return endSession;/.test(hybridSessionHookSrc) && /stopOperatorSessionRuns\(controller, pendingOwner, detachedOwners\)/.test(hybridSessionHookSrc),
  "continuous-session unmount is wired to owner-scoped teardown",
);
ok(
  /turnEpochRef\.current\.begin\(\)/.test(hybridSessionHookSrc) &&
    /waitForCurrentOperatorTurn\(/.test(hybridSessionHookSrc) &&
    /turnEpochRef\.current\.invalidate\(\)/.test(hybridSessionHookSrc) &&
    /operatorStopQueueRef\.current!\.enqueue\(interruptedOwner \?\? null\)/.test(hybridSessionHookSrc) &&
    /activeTurnTerminalRef/.test(hybridSessionHookSrc),
  "local route retains scoped stop and in-flight-terminal gates through interruption/teardown",
);
ok(
  /toolTurnEpoch\.begin\(\)/.test(realtimeSrc) &&
    /waitForCurrentOperatorTurn\(/.test(realtimeSrc) &&
    /toolTurnEpoch\.invalidate\(\)/.test(realtimeSrc) &&
    /new SerializedOperatorStopQueue\(\)/.test(realtimeSrc) &&
    /activeToolTerminal/.test(realtimeSrc),
  "Realtime uses the tested latest-turn and in-flight-terminal gates",
);
ok(
  /stopOperatorSessionRuns\(controller, pendingOwner, detachedOwners\)/.test(realtimeSrc),
  "Realtime teardown stops pending and detached session owners",
);
ok(
  /endSession\(\);\s*onEnd\(\);/.test(hybridSessionPanelSrc) && /onClick=\{end\}/.test(hybridSessionPanelSrc),
  "Esc and close invoke teardown before unmount",
);
ok(
  /registerAsyncCleanup\(async \(\) =>/.test(hybridSessionHookSrc) &&
    /disposeTauriHalt\(\)/.test(hybridSessionHookSrc),
  "Hybrid HALT listener uses the tested late-registration cleanup",
);
ok(
  /native_op_try[\s\S]{0,180}ownerToken:\s*ownerToken \?\? null/.test(routerSrc) &&
    /native_op_try[\s\S]{0,180}ownerToken:\s*ownerToken \?\? null/.test(routeSrc),
  "both voice paths forward the exact owner into native_op_try",
);
ok(
  /computer_use_operate[\s\S]{0,180}ownerToken:\s*opts\?\.ownerToken \?\? null/.test(orchestratorSrc) &&
    /startOwnedOrchestration\(opts\.ownerToken, opts\.signal/.test(respondSrc) &&
    /startOwnedOrchestration\(ownerToken, signal/.test(executeSrc) &&
    /const ownerToken = praxisOwnerToken\("build"\)[\s\S]{0,400}startOwnedOrchestration\(ownerToken, undefined/.test(routerSrc) &&
    /orchestrate\(goal, \{ unattended: true, signal, ownerToken: normalizedOwner/.test(unattendedSrc),
  "single-task, captured-skill, and unattended escalation register exact ownership",
);
// 2026-09-16: a job Atlas hands to Praxis must OUTLIVE the voice session. Ctrl+T
// closes after one turn and endSession() stops every owner the session minted, so a
// session-owned build was stopped seconds after "it's building it now". Builds and
// unattended runs get a Praxis owner (HALT ALL still stops them), and an explicit
// escalate tool call goes straight to Praxis instead of a 6s re-classification.
ok(
  /startUnattendedRun\(focusNote, praxisOwnerToken\("unattended"\)\)/.test(routerSrc) &&
    !/startOwnedOrchestration\(ownerToken, signal/.test(routerSrc) &&
    /export async function routeEscalation/.test(routerSrc) &&
    /name === "escalate"[\s\S]{0,400}routeEscalation\(goal/.test(hybridToolsSrc) &&
    /\.then\(\(result\) => announceOutcome\(result\)\)/.test(routerSrc),
  "voice-escalated builds and unattended runs are Praxis-owned, announced, and escalate skips re-classification",
);
{
  // Live 2026-09-17: the site was built, opened and maximized, and Atlas's thread still
  // ended at "Handing that to Praxis - it's building it now."
  const bridgeSrc = fs.readFileSync(path.join(__dirname, "../src/voice/atlasChatBridge.ts"), "utf8");
  const announce = routerSrc.slice(routerSrc.indexOf("async function announceOutcome"), routerSrc.indexOf("function escalate("));
  ok(
    /mirrorJobOutcome\(summary, result\.done\)/.test(announce) &&
      announce.indexOf("mirrorJobOutcome") < announce.indexOf("speak(") &&
      /export function mirrorJobOutcome[\s\S]{0,120}append\("agent", text, done \? "done" : "not done"\)/.test(bridgeSrc),
    "a job Atlas handed to Praxis ends with its outcome in Atlas's own thread (tagged done / not done)",
  );
}
ok(
  /getUnresolvedOperatorOwners\(\)/.test(hybridSessionHookSrc) &&
    /getUnresolvedOperatorOwners\(\)/.test(realtimeSrc) &&
    !/detachedOwnersRef\.current\.clear\(\)/.test(hybridSessionHookSrc) &&
    !/detachedOwnerTokens\.clear\(\)/.test(realtimeSrc),
  "local and Realtime retry unresolved owners and never clear detached ownership speculatively",
);
ok(
  /wait_for_owner_terminal/.test(computerUseRustSrc) &&
    /wait_for_owner_terminal/.test(sovereignRustSrc) &&
    /wait_for_native_owner_terminal/.test(nativeOpsRustSrc) &&
    /native_op_abort/.test(stopRunsSrc),
  "all desktop actuator stops wait for terminal ownership acknowledgement",
);
const scopedStopBody = stopRunsSrc.match(/export async function stopOperatorRuns[\s\S]*?(?=\/\*\* Explicit global stop)/)?.[0] || "";
const globalStopBody = stopRunsSrc.match(/export async function stopAllOperatorRuns[\s\S]*?(?=function stopMessageIsIdle)/)?.[0] || "";
ok(
  !scopedStopBody.includes("_abort_all") &&
    globalStopBody.includes("computer_use_abort_all") &&
    globalStopBody.includes("sovereign_abort_all") &&
    globalStopBody.includes("native_op_abort_all"),
  "owner replacement remains scoped while HALT ALL keeps separate global commands",
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushUntil(predicate, message) {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(message);
}

async function runBehavioralLifecycleTests() {
  await teardownPromise;

  console.log("\nhybrid session lifecycle behavior");

  const ownedGate = deferred();
  let ownedSignal = null;
  const ownedRun = startOwnedOrchestration(
    "hybrid:ordinary-background",
    undefined,
    async (signal) => {
      ownedSignal = signal;
      await ownedGate.promise;
      return "finished";
    },
  );
  await flushUntil(
    () => ownedOrchestrationCount("hybrid:ordinary-background") === 1 && ownedSignal !== null,
    "ordinary detached orchestration was not registered before admission",
  );
  let ownedStopSettled = false;
  const ownedStop = stopOwnedOrchestration("hybrid:ordinary-background", 500).then((state) => {
    ownedStopSettled = true;
    return state;
  });
  await Promise.resolve();
  ok(ownedSignal.aborted, "scoped stop aborts the exact ordinary detached orchestration signal");
  ok(!ownedStopSettled, "scoped stop cannot acknowledge terminal while detached work still runs");
  ownedGate.resolve();
  await ownedRun;
  ok((await ownedStop) === "requested", "ordinary detached stop resolves after its exact promise terminal");
  ok(
    ownedOrchestrationCount("hybrid:ordinary-background") === 0,
    "ordinary detached owner unregisters only after terminal",
  );

  const dependency = deferred();
  const laneStarts = [];
  const concurrentLanes = settleOperatorStopLanes({
    orchestration: async () => {
      laneStarts.push("orchestration");
      await dependency.promise;
      return "requested";
    },
    unattended: async () => {
      laneStarts.push("unattended");
      await dependency.promise;
      return "requested";
    },
    computerUse: async () => {
      laneStarts.push("computerUse");
      dependency.resolve();
      return "requested";
    },
    sovereign: async () => {
      laneStarts.push("sovereign");
      return "idle";
    },
    native: async () => {
      laneStarts.push("native");
      return "idle";
    },
  });
  const laneResult = await Promise.race([
    concurrentLanes,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("stop lanes deadlocked")), 500)),
  ]);
  ok(
    JSON.stringify(laneStarts) === JSON.stringify([
      "orchestration",
      "unattended",
      "computerUse",
      "sovereign",
      "native",
    ]) && laneResult.orchestration === "requested" && laneResult.unattended === "requested",
    "all scoped stop lanes start concurrently so desktop abort releases dependent owners",
    `starts=${JSON.stringify(laneStarts)}`,
  );

  const teardownRetainedOwner = "hybrid:teardown-retained";
  releaseUnresolvedOperatorOwners([teardownRetainedOwner]);
  const nonterminalTeardown = stopOperatorSessionRuns(
    null,
    null,
    [teardownRetainedOwner],
    async () => ({
      orchestration: "unavailable",
      unattended: "idle",
      computerUse: "idle",
      sovereign: "idle",
      native: "idle",
      terminal: false,
    }),
  );
  ok(
    getUnresolvedOperatorOwners().includes(teardownRetainedOwner),
    "teardown durably retains its owner before awaiting stop acknowledgement",
  );
  await nonterminalTeardown;
  ok(
    getUnresolvedOperatorOwners().includes(teardownRetainedOwner),
    "terminal:false teardown keeps the exact owner for retry",
  );
  await stopOperatorSessionRuns(
    null,
    null,
    [teardownRetainedOwner],
    async () => ({
      orchestration: "idle",
      unattended: "idle",
      computerUse: "idle",
      sovereign: "idle",
      native: "idle",
      terminal: true,
    }),
  );
  ok(
    !getUnresolvedOperatorOwners().includes(teardownRetainedOwner),
    "teardown releases an owner only after exact terminal acknowledgement",
  );

  const thrownTeardownOwner = "realtime:teardown-threw";
  releaseUnresolvedOperatorOwners([thrownTeardownOwner]);
  await stopOperatorSessionRuns(
    null,
    null,
    [thrownTeardownOwner],
    async () => { throw new Error("stop unavailable"); },
  ).catch(() => {});
  ok(
    getUnresolvedOperatorOwners().includes(thrownTeardownOwner),
    "thrown teardown stop retains the owner instead of losing it",
  );
  releaseUnresolvedOperatorOwners([thrownTeardownOwner]);

  for (const resolutionOrder of ["old-first", "new-first"]) {
    const epoch = createOperatorTurnEpoch();
    const oldStop = deferred();
    const newStop = deferred();
    const admitted = [];

    const oldClaim = epoch.begin();
    const oldTurn = waitForCurrentOperatorTurn(epoch, oldClaim, oldStop.promise, () => false)
      .then((current) => {
        if (current) admitted.push("old");
        return current;
      });
    const newClaim = epoch.begin();
    const newTurn = waitForCurrentOperatorTurn(epoch, newClaim, newStop.promise, () => false)
      .then((current) => {
        if (current) admitted.push("new");
        return current;
      });

    if (resolutionOrder === "old-first") {
      oldStop.resolve();
      await oldTurn;
      newStop.resolve();
    } else {
      newStop.resolve();
      await newTurn;
      oldStop.resolve();
    }

    const [oldCurrent, newCurrent] = await Promise.all([oldTurn, newTurn]);
    ok(
      !oldCurrent && newCurrent && JSON.stringify(admitted) === JSON.stringify(["new"]),
      `overlapping local replacements admit only the newest (${resolutionOrder})`,
      `old=${oldCurrent} new=${newCurrent} admitted=${JSON.stringify(admitted)}`,
    );
  }

  const endingEpoch = createOperatorTurnEpoch();
  const endingStop = deferred();
  let ending = false;
  const endingClaim = endingEpoch.begin();
  const waitingTurn = waitForCurrentOperatorTurn(
    endingEpoch,
    endingClaim,
    endingStop.promise,
    () => ending,
  );
  ending = true;
  endingEpoch.invalidate();
  endingStop.resolve();
  ok(!(await waitingTurn), "session teardown while a scoped stop is pending prevents replacement admission");

  const retainedLocalStop = deferred();
  const retainedLocalQueue = new SerializedOperatorStopQueue(async () => retainedLocalStop.promise);
  const retainedLocalEpoch = createOperatorTurnEpoch();
  let retainedOwner = "hybrid:interrupted";
  void retainedLocalQueue.enqueue(retainedOwner); // speech-start begins the scoped stop
  retainedOwner = null; // the interrupted route's finally block clears its owner ref
  const replacementClaim = retainedLocalEpoch.begin();
  let replacementSettled = false;
  const retainedReplacement = waitForCurrentOperatorTurn(
    retainedLocalEpoch,
    replacementClaim,
    retainedLocalQueue.enqueue(retainedOwner),
    () => false,
  ).then((current) => {
    replacementSettled = true;
    return current;
  });
  await Promise.resolve();
  await Promise.resolve();
  ok(!replacementSettled, "local replacement still waits after the interrupted route clears its owner ref");
  retainedLocalStop.resolve();
  ok(await retainedReplacement, "local replacement admits only after the retained scoped stop settles");

  const realtimeStops = [];
  const realtimeStopOwners = [];
  const realtimeQueue = new SerializedOperatorStopQueue(async (owner) => {
    realtimeStopOwners.push(owner);
    const stop = deferred();
    realtimeStops.push(stop);
    await stop.promise;
  });
  const realtimeEpoch = createOperatorTurnEpoch();
  const realtimeAdmitted = [];
  const firstRealtimeClaim = realtimeEpoch.begin();
  const firstRealtime = waitForCurrentOperatorTurn(
    realtimeEpoch,
    firstRealtimeClaim,
    realtimeQueue.enqueue("realtime:prior"),
    () => false,
  ).then((current) => {
    if (current) realtimeAdmitted.push("first");
    return current;
  });
  const secondRealtimeClaim = realtimeEpoch.begin();
  const secondRealtime = waitForCurrentOperatorTurn(
    realtimeEpoch,
    secondRealtimeClaim,
    realtimeQueue.enqueue("realtime:prior"),
    () => false,
  ).then((current) => {
    if (current) realtimeAdmitted.push("second");
    return current;
  });

  await flushUntil(() => realtimeStops.length === 1, "serialized Realtime stop never started");
  realtimeStops[0].resolve();
  const [firstRealtimeCurrent, secondRealtimeCurrent] = await Promise.all([
    firstRealtime,
    secondRealtime,
  ]);
  ok(
    !firstRealtimeCurrent && secondRealtimeCurrent &&
      JSON.stringify(realtimeAdmitted) === JSON.stringify(["second"]) &&
      JSON.stringify(realtimeStopOwners) === JSON.stringify(["realtime:prior"]),
    "Realtime replacements share one terminal stop but only the newest tool call admits",
    `first=${firstRealtimeCurrent} second=${secondRealtimeCurrent} admitted=${JSON.stringify(realtimeAdmitted)}`,
  );

  let uncertainAttempts = 0;
  releaseUnresolvedOperatorOwners(["hybrid:uncertain"]);
  const uncertainQueue = new SerializedOperatorStopQueue(async () => {
    uncertainAttempts += 1;
    return uncertainAttempts === 1
      ? {
          orchestration: "idle",
          unattended: "idle",
          computerUse: "unavailable",
          sovereign: "idle",
          native: "idle",
          terminal: false,
        }
      : {
          orchestration: "idle",
          unattended: "idle",
          computerUse: "idle",
          sovereign: "idle",
          native: "idle",
          terminal: true,
        };
  });
  const uncertainEpoch = createOperatorTurnEpoch();
  const uncertainClaim = uncertainEpoch.begin();
  ok(
    !(await waitForCurrentOperatorTurn(
      uncertainEpoch,
      uncertainClaim,
      uncertainQueue.enqueue("hybrid:uncertain"),
      () => false,
    )),
    "an unavailable abort lane blocks local/Realtime replacement admission",
  );
  ok(
    getUnresolvedOperatorOwners().includes("hybrid:uncertain"),
    "terminal:false retains the exact owner across local/Realtime admission attempts",
  );
  const retryClaim = uncertainEpoch.begin();
  ok(
    await waitForCurrentOperatorTurn(
      uncertainEpoch,
      retryClaim,
      uncertainQueue.enqueue(null),
      () => false,
    ),
    "a retained owner admits only after a later terminal acknowledgement",
  );
  ok(uncertainAttempts === 2, "failed terminal stop is retained and retried exactly once");
  ok(
    !getUnresolvedOperatorOwners().includes("hybrid:uncertain"),
    "terminal retry releases the retained owner",
  );

  let rejectedAttempts = 0;
  const rejectedQueue = new SerializedOperatorStopQueue(async () => {
    rejectedAttempts += 1;
    if (rejectedAttempts === 1) throw new Error("abort IPC rejected");
  });
  const rejectedEpoch = createOperatorTurnEpoch();
  const rejectedClaim = rejectedEpoch.begin();
  ok(
    !(await waitForCurrentOperatorTurn(
      rejectedEpoch,
      rejectedClaim,
      rejectedQueue.enqueue("realtime:rejected"),
      () => false,
    )),
    "a rejected abort IPC fails closed without admitting the replacement",
  );
  const rejectedRetryClaim = rejectedEpoch.begin();
  ok(
    await waitForCurrentOperatorTurn(
      rejectedEpoch,
      rejectedRetryClaim,
      rejectedQueue.enqueue(null),
      () => false,
    ),
    "a rejected abort IPC can later prove terminal and release the retained owner",
  );

  const teardownRealtimeStop = deferred();
  let teardownRealtimeStopStarted = false;
  const teardownRealtimeQueue = new SerializedOperatorStopQueue(async () => {
    teardownRealtimeStopStarted = true;
    await teardownRealtimeStop.promise;
  });
  const teardownRealtimeEpoch = createOperatorTurnEpoch();
  let realtimeClosing = false;
  const teardownRealtimeClaim = teardownRealtimeEpoch.begin();
  const realtimeWaitingAtTeardown = waitForCurrentOperatorTurn(
    teardownRealtimeEpoch,
    teardownRealtimeClaim,
    teardownRealtimeQueue.enqueue("realtime:teardown"),
    () => realtimeClosing,
  );
  await flushUntil(() => teardownRealtimeStopStarted, "Realtime teardown stop never started");
  realtimeClosing = true;
  teardownRealtimeEpoch.invalidate();
  teardownRealtimeStop.resolve();
  ok(
    !(await realtimeWaitingAtTeardown),
    "Realtime teardown while its serialized stop is pending prevents tool admission",
  );

  const lateRegistration = deferred();
  let lateCleanupCalls = 0;
  const disposeBeforeRegistration = registerAsyncCleanup(() => lateRegistration.promise);
  disposeBeforeRegistration();
  lateRegistration.resolve(() => {
    lateCleanupCalls++;
  });
  await flushUntil(() => lateCleanupCalls === 1, "late listener did not self-unregister");
  disposeBeforeRegistration();
  ok(lateCleanupCalls === 1, "listener resolving after unmount self-unregisters exactly once");

  const liveRegistration = deferred();
  let liveCleanupCalls = 0;
  const disposeAfterRegistration = registerAsyncCleanup(() => liveRegistration.promise);
  liveRegistration.resolve(() => {
    liveCleanupCalls++;
  });
  await Promise.resolve();
  disposeAfterRegistration();
  disposeAfterRegistration();
  ok(liveCleanupCalls === 1, "registered listener cleanup is idempotent after normal setup");
}

async function testMissionEscalation() {
  const messages = [], runs = [], spoken = [];
  const compile = (source, req) => {
    const m = { exports: {} };
    const js = esbuild.transformSync(source, { loader: "ts", format: "cjs", supported: { "dynamic-import": false } }).code;
    new Function("module", "exports", "require", "window", js)(m, m.exports, req, { __TAURI_INTERNALS__: {} });
    return m.exports;
  };
  const thread = compile(fs.readFileSync(path.join(__dirname, "../src/orchestrator/missionThread.ts"), "utf8"), (spec) => {
    if (spec === "@tauri-apps/api/core") return { invoke: async (cmd, args) => {
      if (cmd === "agent_chat_append") messages.push(args.meta);
      if (cmd === "agent_chat_read") return messages;
    } };
    if (spec === "@tauri-apps/api/event") return { emit: async () => {} };
    throw Error(spec);
  });
  const router = compile(routerSrc, (spec) => {
    if (spec === "@/orchestrator/missionThread") return thread;
    if (spec === "@/orchestrator/policy") return { isHalted: () => false };
    if (spec === "@/orchestrator/ownedRuns") return ownedRunsMod.exports;
    if (spec === "@/orchestrator/respond") return { tryOrchestrate: (goal, opts) => {
      runs.push({ goal, opts });
      return thread.praxisSay(opts.missionId, "result", "Done", { status: "done" }).then(() => ({ done: true, summary: "Done", missionId: opts.missionId }));
    } };
    if (spec === "./speak") return { speak: (text) => spoken.push(text) };
    if (spec === "@/orchestrator/missionText") return { speakable: (t) => String(t).replace(/[A-Za-z]:\\\S+/g, "its folder") };
    if (spec === "./atlasChatBridge") return { mirrorJobOutcome: () => {} };
    if (spec === "@/store/usePraxisStore") return { usePraxisStore: { getState: () => ({ notify: () => {} }) } };
    return {};
  });
  const brief = "Build a concise personal website. Use Claude, Codex and Cursor. Done means a tested static index.html with a working preview.";
  await router.routeEscalation("make me a concise personal website", { transport: { say: async (text) => spoken.push(text) }, emit: () => {} }, brief);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  ok(messages[0]?.kind === "mission" && messages[0]?.from === "zach" && messages[1]?.kind === "brief" && messages[1]?.from === "atlas", "MT-1: escalate posts Zach mission then Atlas brief");
  ok(runs[0]?.goal === brief && runs[0]?.opts.missionId === messages[0]?.missionId && runs[0]?.opts.missionOpened === true, "MT-1: escalate orchestrates the complete brief with the same missionId");
  ok(runs[0]?.opts.intent === "make me a concise personal website", "escalate passes Zach's own words as intent, so a brief naming Praxis as the actor cannot turn a new project into Praxis-repo work");
  ok(spoken.some((t) => /follow.*Mission/.test(t)) && spoken.some((t) => /^Praxis says: Done/.test(t)), "Atlas announces the Mission handoff, then READS Praxis's own closing words", JSON.stringify(spoken));
  ok(/required: \["goal", "brief"\]/.test(hybridToolsSrc), "MT-1: Atlas escalate schema requires a runnable brief");
}

void testMissionEscalation().then(() => runBehavioralLifecycleTests())
  .then(() => {
    console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((err) => {
    fail++;
    console.error("  ✗ lifecycle behavior harness failed —", err);
    console.log(`\nFAIL — ${pass} passed, ${fail} failed`);
    process.exit(1);
  });
