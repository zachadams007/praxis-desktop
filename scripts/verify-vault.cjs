/**
 * Verifies the Flight Deck Prompt Vault: EDIT existing prompts + per-prompt
 * MODEL and EFFORT selectors. The flight deck reads its data over Tauri `invoke`,
 * which is absent in a plain browser - so we stub `window.__TAURI_INTERNALS__`
 * before load with mock lanes + a LEGACY vault entry (no `effort` field) to also
 * prove the missing-effort migration. Renders /flightdeck.html on the live Vite
 * server, drives the add + edit flows, and asserts the resulting state.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const net = require("net");
const puppeteer = require("puppeteer-core");

const ROOT = path.join(__dirname, "..");
const SHOTS = path.join(ROOT, "verify-shots");
const BASE = "http://127.0.0.1:1430/flightdeck.html";
const PORT = 1430;
const BROWSERS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const W = 1280, H = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = () =>
  new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1");
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });

const results = [];
const check = (name, ok, detail = "") => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  if (!(await portOpen())) { console.log("FAIL: nothing on :1430"); process.exit(1); }
  const exe = BROWSERS.find((p) => fs.existsSync(p));
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: true,
    args: [
      "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--no-sandbox",
      "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
      `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "praxis-vault-"))}`,
      `--window-size=${W},${H}`,
    ],
    defaultViewport: { width: W, height: H },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

  // Stub the Tauri bridge BEFORE any app code runs.
  await page.evaluateOnNewDocument(() => {
    const lane = {
      id: "lane-praxis", label: "Praxis", repoPath: "C:/Users/dev/Desktop/praxis",
      readOnly: false, autoReadOnly: false, userReadOnly: false, background: false,
      total: 0, liveCount: 0, recentCount: 0, archivedCount: 0, collision: false,
      kind: "code", liveBuilderCount: 0, worktrees: [], cards: [], overflow: 0,
    };
    let vault = {
      version: 1,
      lanes: {
        "lane-praxis": [
          // LEGACY entry: no `effort` field on purpose
          { id: "e1", title: "Rebuild the core center", prompt: "Make the neuron nucleus a membrane close-up.", model: "Opus 4.8", runAfter: "", done: false, createdAt: 1 },
        ],
      },
      config: { readOnlyLanes: [], laneOrder: [] },
    };
    window.__TAURI_INTERNALS__ = {
      transformCallback: (cb) => cb,
      invoke: async (cmd, args) => {
        if (cmd === "fd_sessions") return { generatedAt: Date.now(), projectsDir: "C:/Users/dev/Desktop", lanes: [lane] };
        if (cmd === "fd_read_vault") return vault;
        if (cmd === "fd_write_vault") { vault = args.vault; return vault; }
        return null;
      },
    };
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector(".lane", { timeout: 20000 });
  await page.waitForSelector(".vitem", { timeout: 20000 });
  await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, "vault-1-initial.png") });

  // legacy entry shows BOTH a model pill and a (defaulted) effort pill
  const initialPills = await page.$$eval(".vitem-foot .pill", (els) => els.map((e) => e.textContent.trim()));
  check("legacy entry shows model + effort pills (effort defaulted)",
    initialPills.includes("Opus 4.8") && initialPills.includes("high"), JSON.stringify(initialPills));

  // ── ADD flow: open form, confirm model + effort selects, fill, submit ──
  const clickByText = (sel, text) => page.evaluate((sel, text) => {
    const b = [...document.querySelectorAll(sel)].find((x) => x.textContent.trim().includes(text));
    if (b) b.click();
    return !!b;
  }, sel, text);

  await clickByText("button", "+ Prompt");
  await page.waitForSelector('select[aria-label="Reasoning effort level"]', { timeout: 5000 });
  const selectCount = await page.$$eval(".vform select", (e) => e.length);
  check("add form surfaces TWO selects (model + effort)", selectCount === 2, `${selectCount} selects`);
  const effortOpts = await page.$$eval('select[aria-label="Reasoning effort level"] option', (o) => o.map((x) => x.value));
  check("effort select offers max/high/low/1m", ["max", "high", "low", "1m"].every((v) => effortOpts.includes(v)), JSON.stringify(effortOpts));

  await page.type('.vform textarea[aria-label="Prompt text"]', "Wire the planner panel to live spend.");
  await page.type('.vform input[aria-label="Prompt title"]', "Planner spend wiring");
  await page.select('select[aria-label="Target model"]', "Sonnet 4.6");
  await page.select('select[aria-label="Reasoning effort level"]', "max");
  await clickByText(".vform-actions button", "Add to vault");
  await sleep(500);

  const afterAdd = await page.$$eval(".vitem", (items) =>
    items.map((it) => ({
      title: it.querySelector(".vitem-title")?.textContent.trim(),
      pills: [...it.querySelectorAll(".vitem-foot .pill")].map((p) => p.textContent.trim()),
    })),
  );
  const added = afterAdd.find((x) => x.title === "Planner spend wiring");
  check("ADD: new entry carries model + effort", !!added && added.pills.includes("Sonnet 4.6") && added.pills.includes("max"), JSON.stringify(added));
  check("ADD: vault now has 2 entries", afterAdd.length === 2, `${afterAdd.length} entries`);
  await page.screenshot({ path: path.join(SHOTS, "vault-2-added.png") });

  // ── EDIT flow: edit the legacy entry, change prompt + model + effort ──
  await page.evaluate(() => {
    const item = [...document.querySelectorAll(".vitem")].find((it) => it.querySelector(".vitem-title")?.textContent.includes("Rebuild the core center"));
    item?.querySelector('button[title="Edit"]')?.click();
  });
  await page.waitForSelector(".vitem.editing .vform", { timeout: 5000 });
  // edit form should be pre-filled with the existing prompt text
  const prefill = await page.$eval(".vitem.editing textarea", (t) => t.value);
  check("EDIT: form pre-fills existing prompt", /membrane close-up/.test(prefill), prefill.slice(0, 40));
  await page.screenshot({ path: path.join(SHOTS, "vault-3-editing.png") });

  // change the fields
  await page.evaluate(() => { document.querySelector(".vitem.editing textarea").value = ""; });
  await page.type(".vitem.editing textarea", "Make the nucleus richer: brighter membrane web.");
  await page.select('.vitem.editing select[aria-label="Target model"]', "Fable 5");
  await page.select('.vitem.editing select[aria-label="Reasoning effort level"]', "low");
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".vitem.editing .vform-actions button")].find((x) => /Save/.test(x.textContent));
    b?.click();
  });
  await sleep(500);

  const afterEdit = await page.$$eval(".vitem", (items) =>
    items.map((it) => ({
      prompt: it.querySelector(".vitem-prompt")?.textContent.trim(),
      pills: [...it.querySelectorAll(".vitem-foot .pill")].map((p) => p.textContent.trim()),
    })),
  );
  const edited = afterEdit.find((x) => /brighter membrane web/.test(x.prompt || ""));
  check("EDIT: prompt text updated", !!edited, edited ? edited.prompt.slice(0, 40) : "not found");
  check("EDIT: model + effort updated to Fable 5 / low", !!edited && edited.pills.includes("Fable 5") && edited.pills.includes("low"), edited ? JSON.stringify(edited.pills) : "");
  await page.screenshot({ path: path.join(SHOTS, "vault-4-edited.png") });

  // persistence: the stubbed fd_write_vault captured the saved shape
  const saved = await page.evaluate(async () => window.__TAURI_INTERNALS__.invoke("fd_read_vault"));
  const savedEntries = saved.lanes["lane-praxis"];
  check("PERSIST: saved vault has effort on every entry", savedEntries.every((e) => typeof e.effort === "string" && e.effort.length), JSON.stringify(savedEntries.map((e) => e.effort)));

  console.log("\n" + results.join("\n"));
  console.log("\nshots: vault-1-initial · vault-2-added · vault-3-editing · vault-4-edited");
  console.log("console errors:", [...new Set(errors)].filter((e) => !/transformCallback|favicon|DevTools/.test(e)).slice(0, 6).join(" | ") || "none");
  await browser.close();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
