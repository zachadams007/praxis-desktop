const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require("esbuild");
const bundled = buildSync({ entryPoints: [path.join(__dirname, "../src/voice/fallbackAnnouncement.ts")], bundle: true, platform: "node", format: "cjs", write: false });
const mod = { exports: {} };
new Function("module", "exports", bundled.outputFiles[0].text)(mod, mod.exports);
const { announceLocalFallback, FALLBACK_ANNOUNCEMENT } = mod.exports;

(async () => {
  let finishSpeech;
  let captures = 0;
  const spoken = [];
  const cancel = announceLocalFallback({ say(text) { spoken.push(text); return new Promise(resolve => { finishSpeech = resolve; }); }, stopSpeaking() {} }, () => captures++);
  assert.deepEqual(spoken, [FALLBACK_ANNOUNCEMENT]);
  assert.equal(captures, 0, "mic is closed throughout announcement");
  finishSpeech();
  await Promise.resolve();
  cancel();
  assert.equal(captures, 1);

  let stopped = 0;
  const dispose = announceLocalFallback({ say() { return new Promise(resolve => { finishSpeech = resolve; }); }, stopSpeaking() { stopped++; } }, () => captures++);
  dispose();
  finishSpeech();
  await Promise.resolve();
  assert.equal(captures, 1, "ending the session prevents late TTS reopening the mic");
  assert.equal(stopped, 1);

  await new Promise(resolve => {
    announceLocalFallback({ say() { return new Promise(() => {}); }, stopSpeaking() { stopped++; } }, () => { captures++; resolve(); }, 5);
  });
  assert.equal(stopped, 2, "timed-out speech is cancelled before mic opens");
  assert.equal(captures, 2);
  console.log("PASS — fallback announces once, delays capture, cancels safely, and recovers from stalled TTS");
})().catch(error => { console.error(error); process.exitCode = 1; });
