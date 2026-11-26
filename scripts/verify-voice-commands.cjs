/**
 * verify-voice-commands - proves Voice Phase 2 END-TO-END: a spoken command
 * actually MOVES the app (not just parses). Boots the real app, then fires phrases
 * through the DEV bridge window.__praxisVoice(text) - the same dispatch path the mic
 * uses - and asserts the store state changed (view switched, area framed, gesture
 * mode on, thought filed, overview cleared). The mic/STT/TTS still need the owner's voice;
 * THIS proves the wiring from a recognized utterance onward.
 *
 *   node scripts/verify-voice-commands.cjs
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const { spawn, execSync } = require("child_process");
const puppeteer = require("puppeteer-core");

const ROOT = path.join(__dirname, "..");
const BASE = "http://127.0.0.1:1430";
const PORT = 1430;
const BROWSERS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const W = 1480, H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1");
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
}
async function waitForPort(t) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { if (await portOpen()) return true; await sleep(300); }
  return false;
}
let vite;
const killVite = () => { if (vite && vite.pid) { try { execSync(`taskkill /pid ${vite.pid} /T /F`, { stdio: "ignore" }); } catch {} } };

const st = () => window.__praxisStore.getState();

(async () => {
  if (!(await portOpen())) {
    vite = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js")], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    vite.stdout.on("data", (d) => (log += d));
    vite.stderr.on("data", (d) => (log += d));
    if (!(await waitForPort(60000))) { console.log("FAIL: vite never listened\n" + log.slice(-1200)); killVite(); process.exit(1); }
  }

  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error("No Chrome/Edge found");
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: [
      "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--no-sandbox",
      "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
      `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "praxis-voice-"))}`,
      `--window-size=${W},${H}`,
    ],
    defaultViewport: { width: W, height: H },
  });
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });

  let booted = false;
  try {
    await page.waitForFunction(
      () => window.__praxisStore && typeof window.__praxisVoice === "function" && document.querySelector("canvas")?.width > 400,
      { timeout: 30000 },
    );
    booted = true;
  } catch (_) {}
  check("app boots + DEV voice bridge present (window.__praxisVoice)", booted);
  if (!booted) { console.log(results.join("\n")); await browser.close(); killVite(); process.exit(1); }
  await sleep(1200);

  // helper: speak a phrase, let the sync store mutation land, read state
  const say = async (phrase) => {
    await page.evaluate((p) => window.__praxisVoice(p), phrase);
    await sleep(250);
    return page.evaluate(st);
  };

  // 1) "open the journey" → view switches to journey
  let s = await say("open the journey");
  check('"open the journey" → journey view', s.viewMode === "journey", `viewMode=${s.viewMode}`);

  // 2) "forward in time" → time scrub set (non-null), still journey
  s = await say("forward in time");
  check('"forward in time" → time scrub engaged', s.viewMode === "journey" && s.journeyTimeCol !== null, `timeCol=${s.journeyTimeCol}`);

  // 3) "fly to Praxis" → that lane is framed
  s = await say("fly to praxis");
  check('"fly to praxis" → praxis lane framed', s.journeyAreaId === "praxis", `journeyAreaId=${s.journeyAreaId}`);

  // 4) "go to the brain" → back to brain view
  s = await say("go to the brain");
  check('"go to the brain" → brain view', s.viewMode === "brain", `viewMode=${s.viewMode}`);

  // 5) "show me Catalyzed" → camera focus on that area (brain mode)
  s = await say("show me catalyzed");
  check('"show me catalyzed" → focus that area', s.focusId === "catalyzed", `focusId=${s.focusId}`);

  // 6) "gesture mode" → nav mode flips to gesture
  s = await say("gesture mode");
  check('"gesture mode" → gesture nav on', s.mode === "gesture", `mode=${s.mode}`);

  // 7) capture - "remember ..." files a new milestone onto the journey
  const before = (await page.evaluate(st)).journey.length;
  s = await say("remember to wire the command center window next");
  check('"remember ..." → a milestone is filed', s.journey.length === before + 1, `journey ${before} → ${s.journey.length}`);

  // 8) "overview" → selection/focus cleared
  await say("show me finance"); // set a focus first
  s = await say("overview");
  check('"overview" → focus cleared', s.focusId === null && s.selectedId === null, `focusId=${s.focusId}`);

  await browser.close();
  killVite();
  console.log(results.join("\n"));
  console.log(`\n${process.exitCode ? "FAIL" : "PASS"} — voice → app wiring`);
})().catch((e) => {
  console.error("HARNESS FAILURE:", e.stack || e.message);
  killVite();
  process.exit(1);
});
