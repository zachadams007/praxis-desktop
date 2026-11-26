/**
 * Unit-test the REAL-event bridge logic (src/data/realEvents.ts) without a Tauri
 * backend. The useRealEvents hook exposes the PURE mappers on window.__praxisRealEvents
 * in DEV; here we feed synthetic Flight Deck snapshots through the real compiled
 * diffSnapshots and assert the synthesized PraxisEvents.
 *
 *   node scripts/test-real-events.cjs
 *
 * (The LIVE half - polling fd_sessions over real Tauri invoke - can only be exercised
 * in `npm run tauri dev`; this proves the snapshot→event synthesis, the hard part.)
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1");
    s.on("connect", () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
  });
}
async function waitForPort(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (await portOpen()) return true; await sleep(300); }
  return false;
}
let vite;
function killVite() {
  if (vite && vite.pid) { try { execSync(`taskkill /pid ${vite.pid} /T /F`, { stdio: "ignore" }); } catch {} }
}

(async () => {
  if (await portOpen()) {
    console.log("NOTE: something already on :1430 — using it.");
  } else {
    console.log("spawning vite…");
    vite = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js")], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    vite.stdout.on("data", (d) => process.stdout.write(`[vite] ${d}`));
    if (!(await waitForPort(60000))) { console.log("FAIL: vite never listened"); killVite(); process.exit(1); }
  }

  const exe = BROWSERS.find((p) => fs.existsSync(p));
  if (!exe) throw new Error("No Chrome/Edge found");
  const browser = await puppeteer.launch({
    executablePath: exe, headless: true,
    args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
      `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "praxis-re-"))}`],
    defaultViewport: { width: 1280, height: 800 },
  });
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => window.__praxisRealEvents && window.__praxisStore, { timeout: 30000 });

  const out = await page.evaluate(() => {
    const RE = window.__praxisRealEvents;
    const r = [];
    const ok = (name, cond, detail) => r.push({ name, ok: !!cond, detail: detail || "" });

    // Minimal snapshot builder - only the fields diffSnapshots reads.
    //
    // `driver` defaults to "claude" because Lane.driver is a REQUIRED field on the
    // real snapshot (src/flightdeck/types.ts:70, and a String in flightdeck.rs), so
    // a fixture without one was testing a shape the backend can never produce. That
    // gap is what let a hash-random agent pick look correct for months.
    const snap = (root, sessions, driver = "claude") => ({
      generatedAt: 0, projectsDir: "", repos: [{ root, label: root, lanes: [{ driver, sessions }] }],
    });
    const types = (evs) => evs.map((e) => e.type);

    // 1) a session coming alive → agent flies in to its lobe
    // The agent is whoever the DRIVER says, not a hash of the session id. A claude
    // lane is Forge, in every area - the area no longer influences who is working.
    const aId = "a.forge";
    const e1 = RE.diffSnapshots(null, snap("C:/x/praxis", [{ id: "sess-A", running: true, status: "live", mtime: 10, role: "build", preview: "x" }]), 1);
    const w = e1.find((e) => e.type === "agent:status" && e.status === "working");
    ok("session start → agent:status working in the right area+agent", w && w.agentId === aId && w.areaId === "praxis",
      JSON.stringify(w));

    // 2) a running session stopping → agent goes idle
    const prev2 = snap("C:/x/praxis", [{ id: "sess-A", running: true, status: "live", mtime: 10, role: "build", preview: "x" }]);
    const next2 = snap("C:/x/praxis", [{ id: "sess-A", running: false, mtime: 10, role: "build", preview: "x" }]);
    const e2 = RE.diffSnapshots(prev2, next2, 2);
    const idle = e2.find((e) => e.type === "agent:status" && e.status === "idle");
    ok("session stop → agent:status idle", idle && idle.agentId === aId, JSON.stringify(idle));

    // 3) a passive (orchestrator) session producing fresh prose → thinking + the core SPEAKS
    const prev3 = snap("C:/x/praxis", [{ id: "sess-O", running: true, status: "live", mtime: 10, role: "passive", preview: "old" }]);
    const next3 = snap("C:/x/praxis", [{ id: "sess-O", running: true, status: "live", mtime: 20, role: "passive", preview: "Synthesizing the roadmap and drafting next steps" }]);
    const e3 = RE.diffSnapshots(prev3, next3, 3);
    ok("orchestrator activity → agent:thinking (real preview in ticker)", types(e3).includes("agent:thinking"), types(e3).join(","));
    ok("orchestrator activity → orchestrator:speaking (core voice ripple)", types(e3).includes("orchestrator:speaking"), types(e3).join(","));
    const think = e3.find((e) => e.type === "agent:thinking");
    ok("the thought carries the REAL session preview text", think && /Synthesizing/.test(think.thought || ""), think && think.thought);

    // 4) a build session handing off to a DIFFERENT build session in the same area.
    //
    // Two agents in one area now means two TOOLS, which is what a handoff actually
    // is: Claude finishes and Codex picks the work up. It used to be manufactured by
    // hunting for two session ids that happened to hash to different agents - a
    // handoff between two imaginary workers.
    const s1 = { id: "c-claude", a: "a.forge" };
    const s2 = { id: "codex:c-codex", a: "a.vega" };
    const prev4 = snap("C:/x/catalyzed-alpha", [{ id: s1.id, running: true, status: "live", mtime: 10, role: "build", preview: "x" }]);
    const next4 = snap("C:/x/catalyzed-alpha", [
      { id: s1.id, running: false, mtime: 10, role: "build", preview: "x" },
      { id: s2.id, running: true, status: "live", mtime: 11, role: "build", preview: "y" },
    ]);
    const e4 = RE.diffSnapshots(prev4, next4, 4);
    const ho = e4.find((e) => e.type === "agent:handoff");
    ok("build→build relay in one area → agent:handoff (from→to agents)",
      ho && ho.agentId === s1.a && ho.toAgentId === s2.a && ho.areaId === "catalyzed", JSON.stringify(ho));

    // 5) repo→area mapping is sensible + anyRunning works
    ok("repoToArea maps known repos", RE.repoToArea("C:/Users/dev/Desktop/praxis") === "praxis" &&
      RE.repoToArea("Catalyzed Alpha") === "catalyzed" && RE.repoToArea("trading-bot") === "finance",
      [RE.repoToArea("/x/praxis"), RE.repoToArea("Catalyzed Alpha"), RE.repoToArea("trading-bot")].join(","));
    ok("anyRunning detects a live session", RE.anyRunning(prev2) === true && RE.anyRunning(next2) === false);

    // 6) OPEN is not WORKING \u2014 the orbit bug the owner reported twice.
    //
    // The brain keyed the orbit on `running` (the process is alive), which is true of every open
    // sidebar entry. Only `status: "live"` means a prompt is actually being processed.
    const openIdle = { generatedAt: 0, projectsDir: "", repos: [{ root: "C:/Users/dev/Desktop/praxis", label: "praxis",
      lanes: [{ driver: "claude", sessions: [{ id: "s-open", running: true, status: "recent", mtime: 1, role: "build" }] }] }] };
    const busy = { generatedAt: 0, projectsDir: "", repos: [{ root: "C:/Users/dev/Desktop/praxis", label: "praxis",
      lanes: [{ driver: "claude", sessions: [{ id: "s-busy", running: true, status: "live", mtime: 1, role: "build" }] }] }] };
    const flatIdle = [...RE.flattenSnapshot(openIdle).values()][0];
    const flatBusy = [...RE.flattenSnapshot(busy).values()][0];
    ok("an OPEN but idle session is running, and NOT working",
      flatIdle.running === true && flatIdle.working === false,
      JSON.stringify({ running: flatIdle.running, working: flatIdle.working }));
    ok("a session with a live turn IS working",
      flatBusy.running === true && flatBusy.working === true,
      JSON.stringify({ running: flatBusy.running, working: flatBusy.working }));
    // A closed session is neither, whatever its last status said.
    const closed = { generatedAt: 0, projectsDir: "", repos: [{ root: "C:/Users/dev/Desktop/praxis", label: "praxis",
      lanes: [{ driver: "claude", sessions: [{ id: "s-closed", running: false, status: "live", mtime: 1, role: "build" }] }] }] };
    const flatClosed = [...RE.flattenSnapshot(closed).values()][0];
    ok("a dead process never orbits, whatever the transcript last said",
      flatClosed.running === false, JSON.stringify(flatClosed.running));

    const laneWith = (driver) => ({ generatedAt: 0, projectsDir: "", repos: [{
      root: "C:/Users/dev/Desktop/praxis", label: "praxis",
      lanes: [{ driver, sessions: [{ id: "s-" + String(driver), running: true, status: "live", mtime: 9, role: "build" }] }] }] });

    const claudeFlat = [...RE.flattenSnapshot(laneWith("claude")).values()][0];
    ok("a CLAUDE session lights FORGE",
      claudeFlat.agentId === "a.forge", JSON.stringify(claudeFlat.agentId));

    const codexFlat = [...RE.flattenSnapshot(laneWith("codex")).values()][0];
    ok("a CODEX session lights VEGA, not Quill",
      codexFlat.agentId === "a.vega", JSON.stringify(codexFlat.agentId));

    const cursorFlat = [...RE.flattenSnapshot(laneWith("cursor")).values()][0];
    ok("a CURSOR session lights QUILL",
      cursorFlat.agentId === "a.quill", JSON.stringify(cursorFlat.agentId));

    // THE bug, stated as a test: nothing may invent an agent.
    const unknownFlat = [...RE.flattenSnapshot(laneWith(undefined)).values()][0];
    ok("an UNATTRIBUTED session lights NO agent rather than a hashed one",
      unknownFlat.agentId === null, JSON.stringify(unknownFlat.agentId));

    const weirdFlat = [...RE.flattenSnapshot(laneWith("some-new-tool")).values()][0];
    ok("an UNRECOGNISED driver lights NO agent",
      weirdFlat.agentId === null, JSON.stringify(weirdFlat.agentId));

    // And the events that follow must not name a worker either.
    const evs = RE.diffSnapshots(null, laneWith(undefined), 1);
    ok("an unattributed session emits no agent:status",
      evs.every((e) => e.type !== "agent:status"),
      JSON.stringify(evs.map((e) => e.type)));

    const claudeEvs = RE.diffSnapshots(null, laneWith("claude"), 1);
    ok("an attributed session still emits agent:status for the right agent",
      claudeEvs.some((e) => e.type === "agent:status" && e.agentId === "a.forge"),
      JSON.stringify(claudeEvs.filter((e) => e.type === "agent:status").map((e) => e.agentId)));

    const openOnly = snap("C:/x/praxis", [{ id: "s-idle-open", running: true, status: "recent", mtime: 5, role: "build", preview: "old" }]);
    const firstPoll = RE.diffSnapshots(null, openOnly, 1);
    ok("first poll: an OPEN but idle session moves NO agent",
      firstPoll.every((e) => e.type !== "agent:status" && e.type !== "task:start"),
      JSON.stringify(firstPoll.map((e) => e.type)));
    const turnOn = snap("C:/x/praxis", [{ id: "s-turn", running: true, status: "live", mtime: 6, role: "build", preview: "x" }]);
    const turnOff = snap("C:/x/praxis", [{ id: "s-turn", running: true, status: "recent", mtime: 7, role: "build", preview: "x" }]);
    const ended = RE.diffSnapshots(turnOn, turnOff, 2);
    ok("a finished turn idles its agent even while the process stays open",
      ended.some((e) => e.type === "agent:status" && e.status === "idle" && e.agentId === "a.forge"),
      JSON.stringify(ended.map((e) => `${e.type}:${e.status || ""}`)));

    // reconcileFiring: Forge live (a Praxis turn) but orbiting another area -> re-anchored.
    const st = window.__praxisStore.getState();
    st.applyEvent({ type: "agent:status", t: 100, agentId: "a.forge", taskId: undefined, areaId: "catalyzed", status: "working", label: "stale anchor" });
    window.__praxisStore.getState().reconcileFiring(["a.forge"], 101, new Map([["a.forge", [{ areaId: "praxis", taskId: undefined, title: "real turn" }]]]));
    const forge = window.__praxisStore.getState().agents["a.forge"];
    ok("a live agent orbiting where none of its sessions works is pointed at real work",
      forge && forge.status === "working" && forge.areaId === "praxis" && forge.title === "real turn",
      JSON.stringify(forge && { status: forge.status, areaId: forge.areaId, title: forge.title }));
    // ... and an agent already on a live session's area keeps its own (finer) anchor.
    window.__praxisStore.getState().reconcileFiring(["a.forge"], 102, new Map([["a.forge", [{ areaId: "praxis", taskId: "t.other", title: "other" }]]]));
    const forge2 = window.__praxisStore.getState().agents["a.forge"];
    ok("an agent already working in a live area is not re-anchored",
      forge2 && forge2.title === "real turn", JSON.stringify(forge2 && forge2.title));

    return r;
  });

  let fail = 0;
  for (const c of out) { if (!c.ok) fail++; console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`); }
  console.log(`\n${out.length - fail}/${out.length} passed`);
  await browser.close();
  killVite();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS FAILURE:", e.stack || e.message); killVite(); process.exit(1); });
