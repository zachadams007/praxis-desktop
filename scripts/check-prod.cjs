/**
 * check-prod - load the EXACT production bundle (what the release .exe embeds) in a
 * headless browser and catch why it might render blank. `vite preview` serves dist/
 * identically to how Tauri's bundled protocol does, so a JS error here = the same
 * "won't load" blank the WebView2 window shows. Captures pageerror/console + whether
 * #root actually mounted, and screenshots it.
 *
 *   node scripts/check-prod.cjs            (checks index.html - the main brain)
 *   node scripts/check-prod.cjs knowledge  (checks knowledge.html)
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const { spawn, execSync } = require("child_process");
const puppeteer = require("puppeteer-core");

const ROOT = path.join(__dirname, "..");
const PORT = 4317;
const which = process.argv[2] === "knowledge" ? "knowledge.html" : "index.html";
const URL = `http://127.0.0.1:${PORT}/${which === "index.html" ? "" : which}`;
const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = () => new Promise((res) => { const s = net.connect(PORT, "127.0.0.1"); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });
let prev;
const kill = () => { if (prev && prev.pid) { try { execSync(`taskkill /pid ${prev.pid} /T /F`, { stdio: "ignore" }); } catch {} } };

(async () => {
  prev = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "preview", "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; prev.stdout.on("data", (d) => (log += d)); prev.stderr.on("data", (d) => (log += d));
  const t0 = Date.now(); while (Date.now() - t0 < 30000 && !(await portOpen())) await sleep(300);
  if (!(await portOpen())) { console.log("FAIL: vite preview never listened\n" + log.slice(-1000)); kill(); process.exit(1); }

  const exe = BROWSERS.find((p) => fs.existsSync(p));
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "praxis-prod-"))}`, "--window-size=1400,900"], defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 2 } });
  const page = await browser.newPage();
  const errors = [];
  const failed = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + (e.stack || e.message)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });
  page.on("requestfailed", (r) => failed.push(`${r.failure()?.errorText}  ${r.url()}`));
  try { await page.goto(URL, { waitUntil: "networkidle2", timeout: 30000 }); } catch (e) { errors.push("GOTO: " + e.message); }
  await sleep(3500);

  const mounted = await page.evaluate(() => {
    const root = document.getElementById("root");
    const canvas = document.querySelector("canvas");
    const rect = canvas?.getBoundingClientRect();
    return {
      rootChildren: root ? root.children.length : -1,
      canvases: document.querySelectorAll("canvas").length,
      bodyText: (document.body.innerText || "").slice(0, 200),
      devicePixelRatio: window.devicePixelRatio,
      canvasDpr: canvas && rect?.width ? canvas.width / rect.width : 0,
    };
  });
  fs.mkdirSync(path.join(ROOT, "verify-shots"), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, "verify-shots", `prod-${which.replace(".html", "")}.png`) });

  console.log(`URL: ${URL}`);
  console.log(`#root children: ${mounted.rootChildren}   canvases: ${mounted.canvases}`);
  console.log(`mounted: ${mounted.rootChildren > 0 ? "YES — frontend renders" : "NO — blank (this is the 'won't load')"}`);
  const rasterSharp = mounted.canvasDpr >= Math.min(mounted.devicePixelRatio, 2) - 0.05;
  console.log(`canvas DPR: ${mounted.canvasDpr.toFixed(2)} / ${mounted.devicePixelRatio.toFixed(2)} — ${rasterSharp ? "native-resolution" : "DOWNSAMPLED"}`);
  if (failed.length) console.log(`\nFAILED REQUESTS (${failed.length}):\n  ` + failed.slice(0, 8).join("\n  "));
  if (errors.length) console.log(`\nERRORS (${errors.length}):\n  ` + errors.slice(0, 8).join("\n  "));
  else console.log("\nno JS errors captured");
  const gateFailed = mounted.rootChildren <= 0 || !rasterSharp || failed.length > 0 || errors.length > 0;
  await browser.close(); kill();
  if (gateFailed) process.exitCode = 1;
})().catch((e) => { console.error("HARNESS:", e.stack || e.message); kill(); process.exit(1); });
