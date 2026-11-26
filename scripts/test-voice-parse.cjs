/**
 * test-voice-parse - headless test for the wake-word parsing (the one piece of
 * the voice loop that's pure logic; STT/TTS need a real mic + speakers). Same
 * on-the-fly esbuild transpile trick as the gesture engine test.
 *
 *   node scripts/test-voice-parse.cjs
 */
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

const src = fs.readFileSync(path.join(__dirname, "../src/voice/parse.ts"), "utf8");
const { code } = esbuild.transformSync(src, { loader: "ts", format: "cjs", target: "es2020" });
const mod = { exports: {} };
new Function("module", "exports", code)(mod, mod.exports);
const { afterWake, hasWake } = mod.exports;

let pass = 0,
  fail = 0;
const eq = (got, want, msg) => {
  const ok = got === want;
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${msg}${ok ? "" : `  (got "${got}", want "${want}")`}`);
};

console.log("wake detection");
eq(hasWake("praxis what's next"), true, "detects 'praxis'");
eq(hasWake("hey jarvis"), true, "detects 'jarvis'");
eq(hasWake("let's practice driving"), false, "does not false-trigger on 'practice'");
eq(hasWake("open the deck"), false, "no wake word → false");

console.log("command extraction");
eq(afterWake("Praxis, what's next?"), "what's next?", "strips 'Praxis,' + comma");
eq(afterWake("praxis what is next"), "what is next", "strips bare 'praxis'");
eq(afterWake("hey Jarvis, please open flight deck"), "open flight deck", "strips wake + filler 'please'");
eq(afterWake("jarvis can you show me the journey"), "show me the journey", "strips 'can you' filler");
eq(afterWake("Praxis"), "", "wake word alone → empty command (wait for next utterance)");
eq(afterWake("what's the plan"), "what's the plan", "no wake word → returns the text as-is");

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
