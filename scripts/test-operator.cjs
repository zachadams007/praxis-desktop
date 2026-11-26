/**
 * Typed "open spotify" used to be filed as a journey note and nothing opened.
 *
 * Bundles the real modules with esbuild; the router, Atlas's tools, Tauri and the
 * mission thread are replaced by recorders so the loop can be driven headless.
 * Run: node scripts/test-operator.cjs
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// Every replaced module reads its behaviour from this object at call time.
const mock = {
  route: async () => ({ id: "x", transcript: "", resolution: "ignored", detail: "", ts: 0 }),
  routeCalls: [],
  brainReplies: [],
  brainCalls: [],
  toolCalls: [],
  toolResult: (name) => ({ output: `${name} ok`, resolution: "action" }),
  said: [],
  onTool: null,
};
global.__operatorMock = mock;

const MOCKS = {
  "@/voice/hybridRouter": `
    export async function routeHybridUtterance(raw, ctx) {
      const m = globalThis.__operatorMock;
      m.routeCalls.push({ raw, typed: ctx.typed });
      const item = await m.route(raw, ctx);
      ctx.emit(item);
      return item;
    }`,
  "@/voice/hybridTools": `
    export const HYBRID_TOOL_SPECS = [
      { type: "function", name: "halt", description: "stop", parameters: { type: "object", properties: {} } },
      { type: "function", name: "open_app", description: "Open an app.", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
      { type: "function", name: "list_elements", description: "List UI elements.", parameters: { type: "object", properties: { window: { type: "string" } } } },
      { type: "function", name: "click_element", description: "Click by name.", parameters: { type: "object", properties: { name: { type: "string" }, window: { type: "string" } }, required: ["name"] } },
      { type: "function", name: "screenshot", description: "See the screen.", parameters: { type: "object", properties: {} } },
    ];
    export async function dispatchToolCall(name, args, onHalt, signal) {
      const m = globalThis.__operatorMock;
      m.toolCalls.push({ name, args });
      if (m.onTool) m.onTool(name, args);
      const r = m.toolResult(name, args);
      return { output: r.output, resolution: r.resolution, item: { id: "t", transcript: name, resolution: r.resolution, detail: r.output, ts: 0 } };
    }`,
  "@/voice/stopOperatorRuns": `
    const idle = { orchestration: "idle", unattended: "idle", computerUse: "idle", sovereign: "idle", native: "idle", terminal: true };
    export async function stopOperatorRuns() { return idle; }
    export async function stopAllOperatorRuns() { return idle; }`,
  "@tauri-apps/api/core": `
    export async function invoke(cmd, args) {
      const m = globalThis.__operatorMock;
      if (cmd !== "hermes_brain") throw new Error("unexpected invoke " + cmd);
      m.brainCalls.push(args);
      const next = m.brainReplies.shift();
      if (next instanceof Error) throw next;
      return next ?? '{"done":false,"summary":"no reply scripted"}';
    }`,
  "./missionThread": `
    export async function praxisSay(missionId, kind, text, extra = {}) {
      globalThis.__operatorMock.said.push({ missionId, kind, text, ...extra });
      return { missionId, kind, text };
    }`,
  "./brain": `
    export function selectedBrain() {
      return { provider: "openai-codex", model: "gpt-6-astra", fallbacks: [{ provider: "openai-api", model: "gpt-6-astra" }] };
    }`,
};

const mockPlugin = {
  name: "operator-mocks",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      if (MOCKS[args.path] !== undefined && (args.path !== "./missionThread" && args.path !== "./brain" || args.importer.endsWith("operator.ts"))) {
        return { path: args.path, namespace: "mock" };
      }
      return undefined;
    });
    build.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: MOCKS[args.path], loader: "js" }));
  },
};

const buildOptions = {
  stdin: {
    contents: [
      'export * from "./src/orchestrator/operator";',
      'export { classifySubmit, operatorClause, investigationClause } from "./src/orchestrator/submitClassify";',
      'export { stopMissionHere, isMissionRunningHere } from "./src/orchestrator/missionControl";',
      'export { routeArea } from "./src/orchestrator/parse";',
    ].join("\n"),
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  alias: { "@": path.join(root, "src") },
  external: ["@tauri-apps/api/event"],
  plugins: [mockPlugin],
  logLevel: "silent",
};
let op;

let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
};
const reset = () => {
  mock.route = async () => ({ id: "x", transcript: "", resolution: "ignored", detail: "", ts: 0 });
  mock.routeCalls = [];
  mock.brainReplies = [];
  mock.brainCalls = [];
  mock.toolCalls = [];
  mock.toolResult = (name) => ({ output: `${name} ok`, resolution: "action" });
  mock.said = [];
  mock.onTool = null;
};

(async () => {
  // Plugins need the async API.
  const built = await esbuild.build(buildOptions);
  const mod = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(require, mod, mod.exports);
  op = mod.exports;

  // ── The Mission box: what gets DONE now, built, answered or filed ──────────
  await t("typed desktop tasks are done now, not filed as notes", async () => {
    for (const text of [
      "open spotify",
      "search the web for the best mechanical keyboards",
      "click the save button in cursor",
      "go to gmail and find the email from my professor",
      "play lofi on youtube",
      "check my email",
    ]) {
      const plan = op.classifySubmit(text);
      assert.deepEqual(plan.operations, [text], `${text} → operation`);
      assert.equal(plan.fileText, "", `${text} is not filed`);
      assert.deepEqual(plan.goals, [], `${text} is not a build`);
      assert.deepEqual(plan.questions, [], `${text} is not a question`);
    }
  });

  await t("politeness is stripped, and a polite request is not a question", async () => {
    assert.deepEqual(op.classifySubmit("can you open spotify?").operations, ["open spotify"]);
    assert.deepEqual(op.classifySubmit("Please go to youtube.com").operations, ["go to youtube.com"]);
    assert.deepEqual(op.classifySubmit("can you open spotify?").questions, []);
  });

  await t("build verbs and code-shaped asks stay with the build loop", async () => {
    assert.equal(op.operatorClause("open a new file and write a poem"), null, "write → a goal");
    assert.equal(op.operatorClause("find the bug in the deck count"), null, "bug → code");
    assert.equal(op.operatorClause("find out why the usage meter is wrong"), null, "find out → investigate");
    const plan = op.classifySubmit("open a new file and write a poem");
    assert.equal(plan.goals.length, 1);
    assert.deepEqual(plan.operations, []);
  });

  await t("a delivery step after a goal waits for the goal instead of running now", async () => {
    const plan = op.classifySubmit("Build a one-page site about otters. Open it in Chrome when it's done.");
    assert.deepEqual(plan.operations, [], "not opened before it exists");
    assert.equal(plan.goals.length, 1);
    assert.match(plan.goals[0], /Open it in Chrome/);
  });

  await t("a desktop task and a build in one message both happen", async () => {
    const plan = op.classifySubmit("open spotify; build me a landing page for the bakery");
    assert.deepEqual(plan.operations, ["open spotify"]);
    assert.equal(plan.goals.length, 1);
  });

  await t("an investigation runs as a goal; a later plan or a question does not", async () => {
    assert.equal(op.classifySubmit("figure out why the deck count is wrong").goals.length, 1);
    assert.equal(op.classifySubmit("look into why Quill keeps failing").goals.length, 1);
    assert.equal(op.investigationClause("look into broker APIs next week"), false, "a plan to file");
    assert.equal(op.investigationClause("find out why it broke?"), false, "a question");
  });

  await t("questions are still answered", async () => {
    const plan = op.classifySubmit("what's on my calendar today?");
    assert.deepEqual(plan.operations, []);
    assert.equal(plan.questions.length, 1);
  });

  await t("'a short fun-facts section' is not YouTube Shorts (the otters build orbited Studio, live 2026-10-10)", async () => {
    assert.equal(op.routeArea("Build a one-page website about sea otters with a short fun-facts section, in a new folder"), "praxis");
    assert.equal(op.routeArea("post three youtube shorts about otters"), "studio");
    assert.equal(op.routeArea("cut the clip into shorts"), "studio");
  });

  // ── The operator loop ──────────────────────────────────────────────────────
  await t("parses one next step, or the end, and rejects anything else", async () => {
    assert.deepEqual(op.parseOperatorDecision('```json\n{"tool":"open_app","args":{"name":"Spotify"}}\n```'), {
      kind: "tool",
      tool: "open_app",
      args: { name: "Spotify" },
    });
    assert.deepEqual(op.parseOperatorDecision('{"done":true,"summary":"Opened Spotify."}'), { kind: "done", ok: true, summary: "Opened Spotify." });
    assert.deepEqual(op.parseOperatorDecision('{"done":false,"summary":"Needs your password."}'), { kind: "done", ok: false, summary: "Needs your password." });
    assert.equal(op.parseOperatorDecision('{"tool":"screenshot","args":{}}'), null, "a tool the text brain can't use");
    assert.equal(op.parseOperatorDecision('{"tool":"run_shell","args":{"cmd":"del *"}}'), null, "not one of Atlas's tools");
    assert.equal(op.parseOperatorDecision("Sure! I'll open it."), null, "prose");
  });

  await t("the step prompt names the tools and the focus rule", async () => {
    const prompt = op.operatorPrompt("click save in cursor", [{ tool: "list_elements", args: { window: "Cursor" }, result: "Save (button)" }], [
      { name: "click_element", description: "Click by name.", params: "name, window?" },
    ]);
    assert.match(prompt, /click_element\(name, window\?\)/);
    assert.match(prompt, /Praxis's own window has the keyboard focus/);
    assert.match(prompt, /1\. list_elements \{"window":"Cursor"\} → Save \(button\)/);
    assert.match(prompt, /never send messages or buy anything/);
  });

  await t("an instant action finishes on the fast router — no brain call", async () => {
    reset();
    mock.route = async () => ({ id: "r", transcript: "open spotify", resolution: "action", detail: "Opened Spotify.", ts: 0 });
    const r = await op.operateTyped("open spotify", { missionId: "m1" });
    assert.equal(r.done, true);
    assert.equal(mock.routeCalls[0].typed, true, "the router runs in typed (silent) mode");
    assert.equal(mock.brainCalls.length, 0);
    assert.deepEqual(mock.said.map((s) => [s.kind, s.text, s.status]), [["answer", "Opened Spotify.", "done"]]);
  });

  await t("a web answer posts the full cited answer into Mission", async () => {
    reset();
    mock.route = async () => ({ id: "r", transcript: "q", resolution: "answer", detail: "Short brief.", displayMarkdown: "**Full** answer with [sources](https://example.com).", ts: 0 });
    await op.operateTyped("search the web for otters", { missionId: "m2" });
    assert.equal(mock.said[0].text, "**Full** answer with [sources](https://example.com).");
  });

  await t("a blocked action says why and spends no brain call", async () => {
    reset();
    mock.route = async () => ({ id: "r", transcript: "q", resolution: "blocked", detail: "Trust is at Observe — raise it to let me act.", ts: 0 });
    const r = await op.operateTyped("open spotify", { missionId: "m3" });
    assert.equal(r.done, false);
    assert.equal(mock.brainCalls.length, 0);
    assert.deepEqual(mock.said.map((s) => [s.kind, s.status]), [["failure", "failed"]]);
    assert.match(mock.said[0].text, /Trust is at Observe/);
  });

  await t("a multi-step task runs Atlas's tools one at a time until the brain says done", async () => {
    reset();
    mock.brainReplies = [
      '{"tool":"open_app","args":{"name":"Cursor"}}',
      '{"tool":"list_elements","args":{"window":"Cursor"}}',
      '{"tool":"click_element","args":{"name":"Save","window":"Cursor"}}',
      '{"done":true,"summary":"Clicked Save in Cursor."}',
    ];
    const r = await op.operateTyped("click the save button in cursor", { missionId: "m4" });
    assert.equal(r.done, true);
    assert.deepEqual(mock.toolCalls.map((c) => c.name), ["open_app", "list_elements", "click_element"]);
    assert.equal(mock.brainCalls.length, 4);
    assert.equal(mock.brainCalls[0].provider, "openai-codex");
    assert.equal(mock.brainCalls[0].fallbacks.length, 1);
    // Each later call carries what happened so far.
    assert.match(mock.brainCalls[2].goal, /2\. list_elements/);
    const notes = mock.said.filter((s) => s.kind === "note");
    assert.equal(notes.length, 3, "every step is visible in Mission");
    assert.deepEqual(mock.said[mock.said.length - 1], { missionId: "m4", kind: "answer", text: "Clicked Save in Cursor.", status: "done" });
  });

  await t("an unusable brain reply stops honestly instead of guessing", async () => {
    reset();
    mock.brainReplies = ["I would click the save button."];
    const r = await op.operateTyped("click save", { missionId: "m5" });
    assert.equal(r.done, false);
    assert.equal(mock.toolCalls.length, 0);
    assert.equal(mock.said[0].kind, "failure");
  });

  await t("the loop is capped and says where it got to", async () => {
    reset();
    mock.brainReplies = Array.from({ length: 20 }, () => '{"tool":"list_elements","args":{}}');
    const r = await op.operateTyped("find the thing", { missionId: "m6" });
    assert.equal(r.done, false);
    assert.equal(mock.toolCalls.length, op.OPERATOR_MAX_STEPS);
    assert.match(mock.said[mock.said.length - 1].text, /took 8 steps/);
  });

  await t("Stop on the mission strip stops the loop mid-task", async () => {
    reset();
    mock.brainReplies = ['{"tool":"open_app","args":{"name":"Cursor"}}', '{"tool":"list_elements","args":{}}', '{"done":true,"summary":"x"}'];
    mock.onTool = () => op.stopMissionHere("m7");
    const r = await op.operateTyped("click save in cursor", { missionId: "m7" });
    assert.equal(r.done, false);
    assert.equal(r.stopped, true);
    assert.equal(mock.toolCalls.length, 1, "no step after Stop");
    assert.match(mock.said[mock.said.length - 1].text, /^Stopped/);
    assert.equal(op.isMissionRunningHere("m7"), false, "the run unregisters itself");
  });

  await t("while more work shares the mission, an outcome keeps it running", async () => {
    reset();
    mock.route = async () => ({ id: "r", transcript: "q", resolution: "action", detail: "Opened Spotify.", ts: 0 });
    await op.operateTyped("open spotify", { missionId: "m8", closes: false });
    assert.equal(mock.said[0].status, "running");
  });

  console.log(`\nPASS — ${passed} passed, 0 failed`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
