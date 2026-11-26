/**
 * test-suggestion-accept - Atlas accepts the suggestion its own typing opened.
 *
 * The dispatcher now presses Enter when the cover contains the text it just typed, and retries
 * the original call exactly once.
 *
 * Bundles the REAL src/voice/hybridTools.ts (esbuild, `@/` alias) and drives
 * dispatchToolCall against a mocked Tauri `invoke`, so the assertions cover the shipped
 * dispatcher, not a restatement of it. Run:
 *   node scripts/test-suggestion-accept.cjs
 */
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const bundle = esbuild.buildSync({
  entryPoints: [path.join(root, "src/voice/hybridTools.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  write: false,
  alias: { "@": path.join(root, "src") },
  external: ["@tauri-apps/api/*"],
  logLevel: "silent",
});

/** Scripted replies per command; each call shifts one, the last one repeats. */
let script = {};
let calls = [];
async function invoke(cmd, args) {
  calls.push({ cmd, args });
  if (cmd === "desktop_screen_locked") return false;
  const queue = script[cmd];
  if (!queue || !queue.length) throw new Error(`unexpected command ${cmd}`);
  const next = queue.length > 1 ? queue.shift() : queue[0];
  if (next instanceof Error) throw next;
  return typeof next === "function" ? next(args) : next;
}

const store = new Map();
globalThis.window = { __TAURI_INTERNALS__: {} };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

const code = bundle.outputFiles[0].text.replace(/import\("(@tauri-apps\/api\/[^"]+)"\)/g, 'Promise.resolve(require("$1"))');
const mod = { exports: {} };
new Function("require", "module", "exports", code)(
  (spec) => {
    if (spec === "@tauri-apps/api/core") return { invoke };
    if (spec === "@tauri-apps/api/event") return { listen: async () => () => {}, emit: async () => {} };
    return require(spec);
  },
  mod,
  mod.exports,
);
const { dispatchToolCall, coveringSuggestion, OWN_SUGGESTION_MS, HYBRID_TOOL_SPECS } = mod.exports;

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

const ADDRESS = "deckowner1@example.com";
const COVER = "Zachary Adams deckowner1@example.com";
const covered = (field, by) => ({
  ok: false,
  message: `"${field}" is covered by "${by}" — that has to be closed or dismissed first.`,
  method: "none",
  matched: null,
  verified: false,
});
const noHalt = () => ({ ok: true, message: "stopped" });
const dispatch = (name, args) => dispatchToolCall(name, args, noHalt);
const count = (cmd) => calls.filter((c) => c.cmd === cmd).length;

async function typeAddress() {
  script = { hybrid_type: [`Typed "${ADDRESS}".`] };
  calls = [];
  const typed = await dispatch("type_text", { text: ADDRESS });
  if (typed.resolution !== "action") throw new Error(`setup: type_text did not act: ${typed.output}`);
}

(async () => {
  console.log("\ncovered-by-typed-text detection (pure)");
  const now = 1_000_000;
  const typed = { text: ADDRESS, at: now - 5_000 };
  const msg = covered("Subject", COVER).message;
  ok(coveringSuggestion(msg, typed, now) === COVER, "the 09-24 compose-field cover is our own suggestion");
  ok(coveringSuggestion(msg, { text: "DeckOwner1@EXAMPLE.com", at: now }, now) === COVER, "case-insensitive");
  ok(coveringSuggestion(msg, { text: ADDRESS, at: now - OWN_SUGGESTION_MS - 1 }, now) === null, "stale after 90 s");
  ok(coveringSuggestion(msg, { text: ADDRESS, at: now - OWN_SUGGESTION_MS }, now) === COVER, "still ours at exactly 90 s");
  ok(coveringSuggestion(covered("Subject", "Accept all cookies").message, typed, now) === null, "an unrelated cover is not ours");
  ok(coveringSuggestion('"Subject" is covered — that has to be closed or dismissed first.', typed, now) === null, "an unnamed cover is not ours");
  ok(coveringSuggestion(msg, null, now) === null, "nothing typed, nothing accepted");
  ok(coveringSuggestion(msg, { text: "   ", at: now }, now) === null, "whitespace typed matches nothing");
  ok(coveringSuggestion('Clicked "Subject".', typed, now) === null, "a success is never a cover");
  ok(
    coveringSuggestion('"Subject" is covered by "Zach \\"Z\\" Adams deckowner1@example.com" — that has to be closed', typed, now) ===
      'Zach "Z" Adams deckowner1@example.com',
    "Rust's escaped quotes inside the name are read through",
  );

  console.log("\nclick_element: accept, then retry once");
  await typeAddress();
  script = {
    ui_click_element: [covered("Subject", COVER), { ok: true, message: 'Clicked "Subject".', method: "mouse", matched: null, verified: true }],
    hybrid_press: ["Pressed enter."],
  };
  calls = [];
  let res = await dispatch("click_element", { name: "Subject" });
  ok(count("ui_click_element") === 2, "the click is retried exactly once");
  ok(count("hybrid_press") === 1 && calls.find((c) => c.cmd === "hybrid_press").args.key === "enter", "Enter accepts the suggestion");
  ok(
    calls.map((c) => c.cmd).filter((c) => c !== "desktop_screen_locked").join(",") === "ui_click_element,hybrid_press,ui_click_element",
    "order: click, Enter, click",
  );
  ok(calls.find((c) => c.cmd === "hybrid_press").args.origin === "live", "the Enter is a live press (Zach is watching)");
  ok(res.output === `Accepted the suggestion "${COVER}", then clicked "Subject".`, `result says what happened: ${res.output}`);
  ok(res.resolution === "action", "and counts as an action");

  console.log("\nthe retry happens exactly once");
  await typeAddress();
  script = { ui_click_element: [covered("Subject", COVER)], hybrid_press: ["Pressed enter."] };
  calls = [];
  res = await dispatch("click_element", { name: "Subject" });
  ok(count("ui_click_element") === 2, "still covered after the retry: no third attempt");
  ok(count("hybrid_press") === 1, "and only one Enter");
  ok(res.resolution === "blocked" && res.output.startsWith(`Accepted the suggestion "${COVER}", then "Subject" is covered`), `honest result: ${res.output}`);
  // The accepted suggestion is spent: a later covered click does not press Enter again.
  script = { ui_click_element: [covered("Subject", COVER)], hybrid_press: ["Pressed enter."] };
  calls = [];
  await dispatch("click_element", { name: "Subject" });
  ok(count("hybrid_press") === 0 && count("ui_click_element") === 1, "a suggestion is accepted once, not on every later click");

  console.log("\nno retry when the cover isn't ours");
  await typeAddress();
  script = { ui_click_element: [covered("Subject", "Accept all cookies")], hybrid_press: ["Pressed enter."] };
  calls = [];
  res = await dispatch("click_element", { name: "Subject" });
  ok(count("ui_click_element") === 1 && count("hybrid_press") === 0, "a cookie banner is not accepted with Enter");
  ok(res.output === covered("Subject", "Accept all cookies").message, "the original covered message is returned");

  await typeAddress();
  const realNow = Date.now;
  Date.now = () => realNow() + OWN_SUGGESTION_MS + 1_000;
  script = { ui_click_element: [covered("Subject", COVER)], hybrid_press: ["Pressed enter."] };
  calls = [];
  try {
    await dispatch("click_element", { name: "Subject" });
  } finally {
    Date.now = realNow;
  }
  ok(count("ui_click_element") === 1 && count("hybrid_press") === 0, "typing from over 90 s ago is not ours any more");

  console.log("\nfill_field gets the same recovery");
  await typeAddress();
  script = {
    ui_fill_field: [
      { ok: false, message: covered("Subject", COVER).message, matched: null, verified: false, accepted: null },
      { ok: true, message: 'Filled "Subject" with "hello".', matched: null, verified: true, accepted: null },
    ],
    hybrid_press: ["Pressed enter."],
  };
  calls = [];
  res = await dispatch("fill_field", { label: "Subject", text: "hello" });
  ok(count("ui_fill_field") === 2 && count("hybrid_press") === 1, "fill_field: Enter, then one retry");
  ok(res.output === `Accepted the suggestion "${COVER}", then filled "Subject" with "hello".`, `fill result: ${res.output}`);
  const fillArgs = calls.find((c) => c.cmd === "ui_fill_field").args;
  ok(fillArgs.name === "Subject" && fillArgs.text === "hello" && fillArgs.submit === null, "fill_field passes label, text and no submit");

  // fill_field's own text is remembered too: its suggestion covering the next click is accepted.
  script = { ui_fill_field: [{ ok: true, message: `Filled "To recipients" with "${ADDRESS}".`, matched: null, verified: true, accepted: null }] };
  calls = [];
  await dispatch("fill_field", { label: "To", text: ADDRESS });
  script = {
    ui_click_element: [covered("Subject", COVER), { ok: true, message: 'Clicked "Subject".', method: "mouse", matched: null, verified: true }],
    hybrid_press: ["Pressed enter."],
  };
  calls = [];
  res = await dispatch("click_element", { name: "Subject" });
  ok(count("hybrid_press") === 1 && res.output.endsWith('then clicked "Subject".'), "text typed by fill_field is remembered as well");

  console.log("\nfill_field and type_text arguments");
  script = { ui_fill_field: [{ ok: true, message: `Filled "To recipients" with "${ADDRESS}", then pressed Enter.`, matched: null, verified: true, accepted: null }] };
  calls = [];
  res = await dispatch("fill_field", { label: "To", text: ADDRESS, submit: "enter" });
  ok(calls.find((c) => c.cmd === "ui_fill_field").args.submit === "enter", "submit: enter reaches Rust");
  calls = [];
  res = await dispatch("fill_field", { label: "To", text: ADDRESS, submit: "ctrl+enter" });
  ok(res.resolution === "ignored" && count("ui_fill_field") === 0, "a submit other than enter/tab is refused before acting");
  res = await dispatch("fill_field", { label: "", text: "x" });
  ok(res.resolution === "ignored", "fill_field needs a label");

  script = { hybrid_type: [`Typed "${ADDRESS}".`], hybrid_press: ["Pressed enter."] };
  calls = [];
  res = await dispatch("type_text", { text: ADDRESS, then: "enter" });
  ok(
    calls.map((c) => c.cmd).filter((c) => c !== "desktop_screen_locked").join(",") === "hybrid_type,hybrid_press" &&
      calls.find((c) => c.cmd === "hybrid_press").args.key === "enter",
    "type_text then:enter types, then presses Enter",
  );
  ok(res.output === `Typed "${ADDRESS}", then pressed Enter.`, `type_text then result: ${res.output}`);
  calls = [];
  res = await dispatch("type_text", { text: "x", then: "escape" });
  ok(res.resolution === "ignored" && calls.length === 0, "then accepts only enter or tab");

  const specs = Object.fromEntries(HYBRID_TOOL_SPECS.map((s) => [s.name, s]));
  ok(specs.fill_field && specs.fill_field.parameters.required.join() === "label,text", "fill_field({ label, text, submit? }) is advertised");
  ok(JSON.stringify(specs.type_text.parameters.properties.then.enum) === '["enter","tab"]', "type_text advertises then: enter | tab");
  ok(specs.open_url.parameters.properties.browser && specs.web_search.parameters.properties.browser, "open_url / web_search advertise browser");

  console.log("\nthe Realtime prompt teaches plan → act → check");
  const promptSrc = require("node:fs").readFileSync(path.join(root, "src/voice/realtimePrompt.ts"), "utf8");
  const promptMod = { exports: {} };
  new Function("module", "exports", esbuild.transformSync(promptSrc, { loader: "ts", format: "cjs", target: "es2020" }).code)(promptMod, promptMod.exports);
  const prompt = promptMod.exports.REALTIME_SYSTEM_PROMPT;
  ok(!/\$\{/.test(promptSrc.slice(promptSrc.indexOf("REALTIME_SYSTEM_PROMPT"))), "the prompt stays static (no template interpolation) for caching");
  ok(/in THAT browser/.test(prompt) && /pass browser only when he names one/.test(prompt), "continuity: open X means the browser in front");
  ok(/call fill_field\(label, text\)/.test(prompt) && /Never click a field and then type_text/.test(prompt), "forms: fill_field, never click-then-type");
  ok(
    /click_element\("Compose"\) → fill_field\("To", address, submit "enter"\) → fill_field\("Subject"/.test(prompt) && /"Send it\?"/.test(prompt),
    "email: Compose → To (enter) → Subject → Body → ask Send it?",
  );
  ok(/ONE turn of tool calls/.test(prompt), "a dictated email is one turn of tool calls");
  ok(/without making that call in the same turn/.test(prompt), "never announce an action without the call");
  ok(/recovery once/.test(prompt) && /clear_popups/.test(prompt), "try the obvious recovery once before telling him");
  ok(/Say done only on evidence/.test(prompt), "done only on evidence");
  ok(!/default browser\./.test(prompt), "the prompt no longer says pages open in the default browser");

  console.log(`\n${failed ? "FAIL" : "PASS"} — ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
