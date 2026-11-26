/**
 * Tests for the Mission chat's pure logic (src/components/mission/*) and the Inbox's
 * "Delivered" source (src/command/inboxStore.ts).
 *
 * Run: node scripts/test-mission-ui.cjs
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
// A tiny DOM-less window so the bundled modules (visibility, missionThread) load in node.
global.window = {
  dispatchEvent() {
    return true;
  },
  addEventListener() {},
  removeEventListener() {},
};
global.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};

function loadModule(relativePath) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, relativePath)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    write: false,
    alias: { "@": path.join(root, "src") },
    external: ["@tauri-apps/api/*", "@tauri-apps/plugin-opener"],
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const T = loadModule("src/orchestrator/missionThread.ts");
const L = loadModule("src/components/mission/missionLogic.ts");
const MD = loadModule("src/components/mission/lightMarkdown.ts");
const O = loadModule("src/components/mission/openArtifact.ts");
const I = loadModule("src/command/inboxStore.ts");

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  PASS  ${name}`);
    });
}

let n = 0;
/** A mission message with a deterministic id and timestamp. */
const mk = (missionId, kind, ts, extra = {}) =>
  ({ id: `id${(n += 1)}`, ts, missionId, from: "praxis", kind, text: extra.text ?? kind, ...extra });

(async () => {
  // ----------------------------------------------------------- inbox mapping ---
  await test("inbox: a result becomes a DELIVERED row from PRAXIS with the same open actions", () => {
    const artifacts = [
      { kind: "preview", label: "Open preview", target: "file:///C:/Users/dev/site/index.html" },
      { kind: "folder", label: "Open folder", target: "C:\\Users\\dev\\site" },
    ];
    const thread = [
      mk("m1", "mission", 1000, { from: "zach", title: "Personal website", text: "Make a personal website." }),
      mk("m1", "plan", 2000, { status: "running" }),
      mk("m1", "result", 9000, { status: "done", text: "**Done in 6 min.** Your site is ready.\nOpen it below.", artifacts }),
    ];
    const items = I.deliveredItems(thread, new Set(), 9500);
    assert.equal(items.length, 1);
    const it = items[0];
    assert.equal(it.from, "PRAXIS");
    assert.equal(it.title, "Personal website");
    assert.equal(it.tag, "DELIVERED");
    assert.equal(it.text, "Done in 6 min. Your site is ready.", "the summary is one plain line");
    assert.equal(it.unread, true);
    assert.equal(it.id, `delivered-${thread[2].id}`);
    assert.deepEqual(it.actions, artifacts, "the same artifacts, so the same buttons");
    assert.match(it.time, /^\d\d:\d\d$/, "same-day rows show a clock time");
  });

  await test("inbox: an unresolved failure is a NEEDS YOU row; a resolved one is not", () => {
    const thread = [
      mk("a", "mission", 1, { from: "zach", title: "Gmail draft" }),
      mk("a", "failure", 5, { status: "failed", text: "Not finished: Forge hit a rate limit." }),
      mk("b", "mission", 2, { from: "zach", title: "Resolved one" }),
      mk("b", "failure", 6, { status: "failed", text: "first try failed" }),
      mk("b", "result", 9, { status: "done", text: "Finished on the retry." }),
    ];
    const items = I.deliveredItems(thread, new Set(), 20);
    const byTitle = Object.fromEntries(items.map((x) => [x.title, x]));
    assert.equal(byTitle["Gmail draft"].tag, "NEEDS YOU");
    assert.equal(byTitle["Gmail draft"].dotColor, "#e8509d", "needs-you uses the CC attention pink");
    assert.equal(byTitle["Gmail draft"].actions, undefined, "no artifacts → no buttons");
    assert.equal(byTitle["Resolved one"].tag, "DELIVERED");
    assert.equal(items.filter((x) => x.title === "Resolved one").length, 1, "the resolved failure is not listed");
  });

  await test("inbox: asking again and getting it delivered supersedes the earlier failure (same request)", () => {
    const thread = [
      mk("x1", "mission", 1, { from: "zach", title: "Make a very concise personal website for me." }),
      mk("x1", "failure", 5, { status: "failed", text: "Not finished. What stopped it: every agent was out." }),
      mk("x2", "mission", 10, { from: "zach", title: "Make a very concise personal website for me." }),
      mk("x2", "result", 20, { status: "done", text: "Done in 11 min - your site is ready." }),
      mk("y1", "mission", 30, { from: "zach", title: "Make a very concise personal website for me." }),
      mk("y1", "failure", 40, { status: "failed", text: "A newer failure is still real." }),
    ];
    const items = I.deliveredItems(thread, new Set(), 50);
    assert.deepEqual(items.map((x) => x.tag), ["NEEDS YOU", "DELIVERED"], "the old failure is gone; a failure AFTER the delivery stays");
  });

  await test("inbox: a mission Zach stopped himself is not a NEEDS YOU row; a real failure still is", () => {
    const thread = [
      mk("s1", "mission", 1, { from: "zach", title: "Write a prime script" }),
      mk("s1", "failure", 5, { status: "failed", text: "Stopped — you stopped this mission. Nothing had finished yet." }),
      mk("q1", "mission", 6, { from: "zach", title: "Queued thing" }),
      mk("q1", "failure", 7, { status: "failed", text: "Stopped — you cancelled this queued mission before it started." }),
      mk("f1", "mission", 10, { from: "zach", title: "Broken thing" }),
      mk("f1", "failure", 20, { status: "failed", text: "Not finished. What stopped it: every agent was out." }),
    ];
    const items = I.deliveredItems(thread, new Set(), 50);
    assert.deepEqual(items.map((x) => x.title), ["Broken thing"], "only the real failure waits on Zach");
  });

  await test("inbox: read state persists per id, newest first, quiet thread = no rows, capped", () => {
    const thread = [];
    for (let i = 0; i < 20; i += 1) {
      thread.push(mk(`m${i}`, "mission", i * 10, { from: "zach", title: `Job ${i}` }));
      thread.push(mk(`m${i}`, "result", i * 10 + 5, { status: "done", text: `Done ${i}` }));
    }
    const first = I.deliveredItems(thread, new Set(), 1000);
    assert.equal(first.length, 12, "capped");
    assert.equal(first[0].title, "Job 19", "newest first");
    const read = new Set([first[0].id]);
    const again = I.deliveredItems(thread, read, 1000);
    assert.equal(again[0].unread, false);
    assert.equal(again[1].unread, true);
    assert.deepEqual(I.deliveredItems([], new Set(), 5), [], "real sources only: nothing posted, nothing shown");
    assert.deepEqual(
      I.deliveredItems([mk("q", "mission", 1, { from: "zach" }), mk("q", "plan", 2)], new Set(), 5),
      [],
      "a mission with no result yet is not delivered",
    );
  });

  await test("inbox: an older-day row shows its date", () => {
    const d = new Date(2026, 8, 28, 14, 2).getTime();
    const now = new Date(2026, 8, 30, 9, 0).getTime();
    const items = I.deliveredItems([mk("o", "result", d, { text: "ok", status: "done" })], new Set(), now);
    assert.equal(items[0].time, "2026-09-28 14:02");
  });

  // ------------------------------------------------------- who is working now ---
  await test("running agents: the latest dispatch per agent with no later progress row", () => {
    const base = [
      mk("m", "mission", 1, { from: "zach" }),
      mk("m", "plan", 2, { status: "running" }),
      mk("m", "dispatch", 3, { agent: "forge", model: "claude-opus-4-8", step: { index: 1, of: 3 } }),
      mk("m", "dispatch", 4, { agent: "vega", model: "gpt-6-astra", step: { index: 2, of: 3 } }),
    ];
    assert.deepEqual(L.runningAgents(base).map((a) => a.agent), ["forge", "vega"]);
    assert.equal(L.runningAgents(base)[0].model, "claude-opus-4-8");
    assert.deepEqual(L.runningAgents(base)[1].step, { index: 2, of: 3 });

    const forgeDone = [...base, mk("m", "progress", 5, { agent: "forge", text: "layout done" })];
    assert.deepEqual(L.runningAgents(forgeDone).map((a) => a.agent), ["vega"]);

    const forgeAgain = [...forgeDone, mk("m", "dispatch", 6, { agent: "forge", step: { index: 3, of: 3 } })];
    assert.deepEqual(L.runningAgents(forgeAgain).map((a) => a.agent), ["vega", "forge"], "a new dispatch makes it work again, oldest first");

    const fromSender = [...base, mk("m", "progress", 5, { from: "vega", text: "copy done" })];
    assert.deepEqual(L.runningAgents(fromSender).map((a) => a.agent), ["forge"], "a progress row from the agent itself counts");
  });

  await test("running agents: a reroute takes the unavailable agent off; the stand-in appears with ITS dispatch; a result clears everyone", () => {
    const thread = [
      mk("m", "dispatch", 3, { agent: "quill", step: { index: 1, of: 2 } }),
      mk("m", "reroute", 4, { agent: "quill", standIn: "vega", text: "Quill is out of credits until 14:00." }),
    ];
    assert.deepEqual(L.runningAgents(thread).map((a) => a.agent), [], "Quill is off; Vega is not working until it is dispatched");
    const taken = [...thread, mk("m", "dispatch", 5, { agent: "vega", step: { index: 1, of: 2 } })];
    assert.deepEqual(L.runningAgents(taken).map((a) => a.agent), ["vega"], "Vega's dispatch row puts it on");
    const planTime = [mk("m", "plan", 1, { status: "running" }), mk("m", "reroute", 2, { agent: "quill" })];
    assert.deepEqual(L.runningAgents(planTime), [], "a reroute with no stand-in leaves nobody working");
    const done = [...taken, mk("m", "result", 9, { status: "done" })];
    assert.deepEqual(L.runningAgents(done), []);
    const failed = [...thread, mk("m", "failure", 9, { status: "failed" })];
    assert.deepEqual(L.runningAgents(failed), []);
  });

  await test("mission view: live status, elapsed time, and 'interrupted' for a run from before this window", () => {
    const thread = [
      mk("m", "mission", 1000, { from: "zach", title: "Site" }),
      mk("m", "plan", 2000, { status: "running" }),
      mk("m", "dispatch", 3000, { agent: "forge", step: { index: 1, of: 2 } }),
    ];
    const g = T.groupMissions(thread)[0];
    const live = L.missionView(g, 500); // the window started before the mission
    assert.equal(live.status, "running");
    assert.equal(live.endedAt, null);
    assert.equal(L.elapsedMs(live, 8000), 7000, "elapsed ticks while running");
    assert.deepEqual(live.step, { index: 1, of: 2 });
    assert.deepEqual([...live.liveDispatchIds], [thread[2].id]);

    const stale = L.missionView(g, 10_000); // the window started AFTER its last word
    assert.equal(stale.status, "interrupted", "a running mission that predates this window can never finish");
    assert.equal(stale.endedAt, 3000);
    assert.deepEqual(stale.agents, [], "nobody is working in an interrupted mission");
    assert.equal(L.elapsedMs(stale, 99_999), 2000, "elapsed freezes at its last word");

    const done = L.missionView(T.groupMissions([...thread, mk("m", "result", 9000, { status: "done" })])[0], 500);
    assert.equal(done.status, "done");
    assert.equal(done.endedAt, 9000);
    assert.equal(L.elapsedMs(done, 123_456), 8000, "elapsed freezes at the result");
  });

  await test("phase: planning -> starting -> between steps, from the thread alone", () => {
    assert.equal(L.missionPhase([mk("m", "mission", 1, { from: "zach" })]), "planning");
    assert.equal(L.missionPhase([mk("m", "mission", 1, { from: "zach" }), mk("m", "plan", 2)]), "starting");
    assert.equal(L.missionPhase([mk("m", "plan", 2), mk("m", "dispatch", 3, { agent: "forge" }), mk("m", "progress", 4, { agent: "forge" })]), "between");
  });

  await test("clearing hides finished missions up to the boundary; a running one and newer ones stay", () => {
    const groups = T.groupMissions([
      mk("done1", "mission", 1, { from: "zach", title: "Done" }),
      mk("done1", "result", 2, { status: "done" }),
      mk("live", "mission", 3, { from: "zach", title: "Live" }),
      mk("live", "plan", 4, { status: "running" }),
      mk("later", "mission", 9, { from: "zach", title: "Later" }),
      mk("later", "answer", 10, { status: "done" }),
    ]);
    assert.deepEqual(L.visibleMissions(groups, 0, 0).map((g) => g.missionId), ["done1", "live", "later"], "no clear → everything");
    assert.deepEqual(L.visibleMissions(groups, 5, 0).map((g) => g.missionId), ["live", "later"], "running kept, newer kept");
    assert.deepEqual(L.visibleMissions(groups, 5, 100).map((g) => g.missionId), ["later"], "a 'running' mission from a dead window is cleared too");
  });

  await test("header strip: the running mission wins; a finished one lingers, then gets out of the way", () => {
    const groups = T.groupMissions([
      mk("old", "mission", 1, { from: "zach", title: "Old" }),
      mk("old", "result", 2, { status: "done" }),
      mk("new", "mission", 3, { from: "zach", title: "New" }),
      mk("new", "plan", 4, { status: "running" }),
    ]);
    assert.equal(L.stripMission(groups, 5, 0).title, "New");
    const finished = T.groupMissions([mk("x", "mission", 1000, { from: "zach", title: "X" }), mk("x", "result", 2000, { status: "done" })]);
    assert.equal(L.stripMission(finished, 3000, 0).title, "X", "fresh result keeps the strip");
    assert.equal(L.stripMission(finished, 2000 + L.STRIP_LINGER_MS + 1, 0), null, "an old one doesn't");
  });

  // ------------------------------------------------------------------- unread ---
  await test("unread counting: only Praxis / Atlas / agents, only newer than last seen", () => {
    const thread = [
      mk("m", "mission", 10, { from: "zach" }),
      mk("m", "brief", 11, { from: "atlas" }),
      mk("m", "plan", 12),
      mk("m", "dispatch", 13, { agent: "forge" }),
      mk("m", "result", 20, { status: "done" }),
    ];
    const all = L.unreadSummary(thread, 0);
    assert.equal(all.count, 4, "Zach's own message never counts");
    assert.equal(all.hasResult, true);
    assert.equal(all.hasFailure, false);
    assert.equal(all.latest.kind, "result");
    const some = L.unreadSummary(thread, 12);
    assert.equal(some.count, 2, "what he already saw is not unread");
    const none = L.unreadSummary(thread, 20);
    assert.equal(none.count, 0);
    assert.equal(none.hasResult, false);
    assert.equal(L.unreadSummary([mk("m", "failure", 5)], 0).hasFailure, true);
  });

  await test("dock state: failure > done glow > running > unread > idle, and seen clears it", () => {
    const run = [mk("m", "mission", 100, { from: "zach", title: "Build the site" }), mk("m", "plan", 101, { status: "running" })];
    // seen everything, mission running → the live ring
    let d = L.dockState(run, 101, 0);
    assert.equal(d.tone, "live");
    assert.equal(d.label, "Build the site");
    assert.equal(d.count, 0);
    // unseen plan while running: still live, but the badge counts it
    d = L.dockState(run, 100, 0);
    assert.equal(d.tone, "live");
    assert.equal(d.count, 1);
    // a result he hasn't seen → the done glow, until he opens the panel
    const done = [...run, mk("m", "result", 200, { status: "done" })];
    d = L.dockState(done, 101, 0);
    assert.equal(d.tone, "done");
    assert.equal(d.label, "done \u00b7 Build the site");
    assert.equal(L.dockState(done, 200, 0).tone, null, "seen → the glow goes away");
    // failure outranks everything
    d = L.dockState([...done, mk("m", "failure", 300, { status: "failed" })], 101, 0);
    assert.equal(d.tone, "failed");
    // a plain reply with nothing running
    const answered = [mk("q", "mission", 1, { from: "zach", title: "Q" }), mk("q", "answer", 2, { status: "done" })];
    d = L.dockState(answered, 1, 0);
    assert.equal(d.tone, "unread");
    assert.equal(d.count, 1);
    assert.equal(L.dockState([], 0, 0).tone, null);
    // a run from before this window is not "live"
    assert.equal(L.dockState(run, 101, 99_999).tone, null, "interrupted missions don't spin forever");
    // the screen-reader line names who said what, only for things he hasn't seen
    d = L.dockState([...run, mk("m", "answer", 150, { text: "**Yes** — it shipped." })], 101, 0);
    assert.equal(d.announce, "Praxis: Yes — it shipped.");
    assert.equal(L.dockState(run, 101, 0).announce, "", "nothing unseen, nothing to announce");
    assert.equal(L.senderName("zach"), "You");
    assert.equal(L.senderName("atlas"), "Atlas");
  });

  // -------------------------------------------------------------- auto-open ---
  await test("auto-open: a new mission or brief opens the panel once, never over a field Zach is typing in", () => {
    const now = 1_000_000;
    const base = { now, dumpOpen: false, openedFor: new Set() };
    const mission = mk("m", "mission", now - 100, { from: "zach" });
    const brief = mk("m", "brief", now - 50, { from: "atlas" });
    assert.equal(L.shouldAutoOpen({ ...base, msg: mission }), true);
    assert.equal(L.shouldAutoOpen({ ...base, msg: brief }), true);
    assert.equal(L.shouldAutoOpen({ ...base, msg: mk("m", "plan", now - 10) }), false, "only a start opens it");
    assert.equal(L.shouldAutoOpen({ ...base, msg: mk("m", "result", now - 10) }), false);
    assert.equal(L.shouldAutoOpen({ ...base, dumpOpen: true, msg: mission }), false, "already open");
    assert.equal(L.shouldAutoOpen({ ...base, openedFor: new Set(["m"]), msg: brief }), false, "once per mission");
    assert.equal(L.shouldAutoOpen({ ...base, msg: mk("old", "mission", now - L.AUTO_OPEN_MAX_AGE_MS - 1) }), false, "old news");
  });

  // ------------------------------------------------------------ thread merge ---
  await test("merge: dedupes by id, keeps order, caps, and returns the same array when nothing is new", () => {
    const a = mk("m", "mission", 1);
    const b = mk("m", "plan", 3);
    const c = mk("m", "dispatch", 2);
    const merged = L.mergeThread([a, b], [c, a, c]);
    assert.deepEqual(merged.map((m) => m.ts), [1, 2, 3]);
    const prev = [a, b];
    assert.equal(L.mergeThread(prev, [a, b]), prev, "no churn");
    const many = Array.from({ length: 10 }, (_, i) => mk("m", "note", i));
    assert.equal(L.mergeThread([], many, 4).length, 4);
    assert.equal(L.mergeThread([], many, 4)[0].ts, 6, "the newest are kept");
    assert.equal(L.maxTs(many), 9);
    assert.equal(L.maxTs([]), 0);
  });

  // ------------------------------------------------------------- formatting ---
  await test("formatters: elapsed, plan lines, summary line, model chip", () => {
    assert.equal(L.fmtElapsed(7000), "0:07");
    assert.equal(L.fmtElapsed(134_000), "2:14");
    assert.equal(L.fmtElapsed(3_734_000), "1:02:14");
    assert.equal(L.fmtElapsed(-5), "0:00");
    assert.deepEqual(L.parsePlanLines("Forge: builds the layout\nVega \u2014 writes copy\nWorkspace: C:\\work\\site\nUse the shared theme."), [
      { kind: "agent", agent: "forge", text: "builds the layout" },
      { kind: "agent", agent: "vega", text: "writes copy" },
      { kind: "workspace", path: "C:\\work\\site" },
      { kind: "text", text: "Use the shared theme." },
    ]);
    assert.equal(L.summaryLine("## **Done** `fast`\nmore"), "Done fast");
    assert.ok(L.summaryLine("x".repeat(400)).length <= 160);
    assert.equal(L.prettyModel("claude-opus-4-8"), "opus-4.8");
    assert.equal(L.prettyModel("gpt-6-astra"), "gpt-6-astra");
    assert.equal(L.prettyModel("claude-haiku-4-5-20251001"), "haiku-4.5-20251001");
    assert.equal(L.prettyModel(""), null);
    assert.equal(L.agentName("quill"), "Quill");
  });

  // --------------------------------------------------------- light markdown ---
  await test("light markdown: bold, code, bullets, headings, links as tokens", () => {
    const blocks = MD.parseLight("# Plan\n**Done** in `2 min`.\n\n- one\n- two with [the site](https://x.dev/a)\n  wrapped on\n1. numbered\n\nSee https://a.b/c, then stop.");
    assert.deepEqual(blocks[0], { t: "h", inline: [{ t: "text", v: "Plan" }] });
    assert.deepEqual(blocks[1].inline, [
      { t: "bold", v: "Done" },
      { t: "text", v: " in " },
      { t: "code", v: "2 min" },
      { t: "text", v: "." },
    ]);
    assert.equal(blocks[2].t, "ul");
    assert.equal(blocks[2].items.length, 2);
    assert.deepEqual(blocks[2].items[1][1], { t: "link", label: "the site", href: "https://x.dev/a" });
    assert.ok(blocks[2].items[1].some((x) => x.t === "text" && x.v.includes("wrapped on")), "indented continuation joins its bullet");
    assert.equal(blocks[3].t, "ol", "a numbered item after bullets starts its own ordered list");
    assert.equal(blocks[3].start, 1);
    assert.equal(blocks[3].items.length, 1);
    const ordered = MD.parseLight("Steps:\n3. third\n4. fourth\n\n- then a bullet");
    assert.equal(ordered[1].t, "ol");
    assert.equal(ordered[1].start, 3, "the original numbering is kept");
    assert.equal(ordered[1].items.length, 2);
    assert.equal(ordered[2].t, "ul");
    const last = blocks[4].inline;
    assert.deepEqual(last[1], { t: "link", label: "https://a.b/c", href: "https://a.b/c" });
    assert.deepEqual(last[2], { t: "text", v: ", then stop." }, "trailing punctuation is not part of the link");
  });

  await test("light markdown: only http(s) links become buttons; file:// and javascript: stay inert text", () => {
    const b = MD.parseLight("[x](javascript:alert(1)) and <img src=x onerror=alert(1)> and file:///C:/a/b.exe and [run](file:///C:/a/b.bat) and https://ok.dev/a");
    const kinds = b[0].inline.map((x) => x.t);
    assert.ok(!b[0].inline.some((x) => x.t === "link" && /javascript/i.test(x.href)));
    assert.deepEqual(
      b[0].inline.filter((x) => x.t === "link").map((x) => x.href),
      ["https://ok.dev/a"],
      "agent output can never make a button that opens a local path",
    );
    assert.ok(b[0].inline.some((x) => x.t === "text" && x.v.includes("file:///C:/a/b.exe")), "the file:// URL stays visible as text");
    assert.ok(b[0].inline.some((x) => x.t === "text" && x.v.includes("run (file:///C:/a/b.bat)")), "a file:// markdown link degrades to label + address");
    assert.ok(kinds.includes("text"));
    assert.ok(b[0].inline.some((x) => x.t === "text" && x.v.includes("<img")), "html is left as literal text for React to escape");
    assert.equal(MD.parseLight("")[0], undefined);
    const big = MD.parseLight("a".repeat(MD.MAX_RENDER_CHARS * 2));
    assert.ok(big[0].inline[0].v.length <= MD.MAX_RENDER_CHARS + 1, "bounded");
  });

  await test("light markdown: terminal colour codes and control characters never reach the screen", () => {
    const raw = "\u001b[32mPASS\u001b[0m 12 tests\u001b]0;title\u0007\u0000\u0008 done\rnext line";
    assert.equal(MD.stripControl(raw), "PASS 12 tests done\nnext line");
    const b = MD.parseLight("\u001b[1;31mFAILED\u001b[0m: **bold** after");
    assert.deepEqual(b[0].inline[0], { t: "text", v: "FAILED: " });
    assert.deepEqual(b[0].inline[1], { t: "bold", v: "bold" });
  });

  // ---------------------------------------------------------------- opening ---
  const fakeDeps = (over = {}) => {
    const calls = [];
    const deps = {
      calls,
      inTauri: () => true,
      invoke: async (cmd, args) => {
        calls.push(["invoke", cmd, args]);
        if (over.invoke) return over.invoke(cmd, args);
        return cmd === "path_exists" ? true : "ok";
      },
      openPath: async (p) => {
        calls.push(["openPath", p]);
        if (over.openPath) return over.openPath(p);
      },
      openUrl: async (u) => {
        calls.push(["openUrl", u]);
        if (over.openUrl) return over.openUrl(u);
      },
      windowOpen: (u) => {
        calls.push(["windowOpen", u]);
        return over.windowOpen ?? false;
      },
    };
    return deps;
  };
  const preview = { kind: "preview", label: "Open preview", target: "file:///C:/Users/dev/My%20Site/index.html" };

  await test("open: a preview goes through desktop_open_url with browser null (after checking the page exists)", async () => {
    const d = fakeDeps();
    const r = await O.openArtifact(preview, d);
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(d.calls[0], ["invoke", "path_exists", { path: "C:\\Users\\dev\\My Site\\index.html" }]);
    assert.deepEqual(d.calls[1], ["invoke", "desktop_open_url", { url: preview.target, browser: null }]);
    assert.equal(d.calls.length, 2);
    // a web preview needs no existence check
    const w = fakeDeps();
    await O.openArtifact({ kind: "preview", label: "Open preview", target: "http://localhost:5173/" }, w);
    assert.deepEqual(w.calls, [["invoke", "desktop_open_url", { url: "http://localhost:5173/", browser: null }]]);
  });

  await test("open: a preview whose page is gone says so instead of opening a blank browser page", async () => {
    const d = fakeDeps({ invoke: async (cmd) => (cmd === "path_exists" ? false : "ok") });
    const r = await O.openArtifact(preview, d);
    assert.equal(r.ok, false);
    assert.match(r.message, /that path does not exist/);
    assert.ok(!d.calls.some((c) => c[1] === "desktop_open_url"), "nothing was opened");
  });

  await test("open: a button never launches a program (exe, bat, scripts) — it points at the folder instead", async () => {
    for (const target of ["C:\\tools\\setup.exe", "file:///C:/tools/run.BAT", "C:\\x\\a.ps1", "C:\\x\\a.js", "C:\\x\\a.lnk"]) {
      for (const kind of ["file", "preview", "folder"]) {
        const d = fakeDeps();
        const r = await O.openArtifact({ kind, label: "x", target }, d);
        assert.equal(r.ok, false, `${kind} ${target}`);
        assert.match(r.message, /won't launch a program/);
        assert.equal(d.calls.length, 0, "nothing reached the shell");
      }
    }
    assert.equal(O.launchesProgram("C:\\site\\index.html"), false);
    assert.equal(O.launchesProgram("C:\\site\\notes.md"), false);
    assert.equal(O.launchesProgram("C:\\site\\app.py"), false);
    assert.equal(O.launchesProgram("C:\\site\\build.cmd"), true);
  });

  await test("open: when desktop_open_url fails, the opener plugin's openUrl is the fallback", async () => {
    const d = fakeDeps({ invoke: async () => { throw new Error("no browser window"); } });
    const r = await O.openArtifact({ kind: "url", label: "Open link", target: "https://example.com/a" }, d);
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(d.calls.map((c) => c[0]), ["invoke", "openUrl"]);
  });

  await test("open: when both fail it says so plainly (never a fake success)", async () => {
    const d = fakeDeps({
      invoke: async () => { throw new Error("browser launch failed"); },
      openUrl: async () => { throw new Error("Not allowed to open url"); },
    });
    const r = await O.openArtifact({ kind: "url", label: "Open link", target: "https://example.com/a" }, d);
    assert.equal(r.ok, false);
    assert.match(r.message, /^Couldn't open https:\/\/example\.com\/a/);
    // a local preview falls back to the opener's openPath, and says so when that fails too
    const p = fakeDeps({
      invoke: async (cmd) => { if (cmd === "path_exists") return true; throw new Error("browser launch failed"); },
      openPath: async () => { throw new Error("Not allowed to open path"); },
    });
    const r2 = await O.openArtifact(preview, p);
    assert.equal(r2.ok, false);
    assert.match(r2.message, /^Couldn't open C:\\Users\\dev\\My Site\\index\.html/);
    const q = fakeDeps({ invoke: async (cmd) => { if (cmd === "path_exists") return true; throw new Error("browser launch failed"); } });
    assert.deepEqual(await O.openArtifact(preview, q), { ok: true }, "openPath rescued it");
    assert.deepEqual(q.calls.at(-1), ["openPath", "C:\\Users\\dev\\My Site\\index.html"]);
  });

  await test("open: a folder or file goes through openPath with a real Windows path", async () => {
    const d = fakeDeps();
    const r = await O.openArtifact({ kind: "folder", label: "Open folder", target: "C:/Users/dev/site" }, d);
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(d.calls.map((c) => c[0]), ["invoke", "openPath"]);
    assert.deepEqual(d.calls[0], ["invoke", "path_exists", { path: "C:\\Users\\dev\\site" }]);
    assert.equal(d.calls[1][1], "C:\\Users\\dev\\site");

    const f = fakeDeps();
    await O.openArtifact({ kind: "file", label: "Open file", target: "file:///C:/Users/dev/My%20Site/notes.md" }, f);
    assert.equal(f.calls[1][1], "C:\\Users\\dev\\My Site\\notes.md", "a file:// URL is decoded to a path");
  });

  await test("open: a missing path is reported, not opened; a refusing plugin falls back to the desktop opener", async () => {
    const gone = fakeDeps({ invoke: async (cmd) => (cmd === "path_exists" ? false : "ok") });
    const r = await O.openArtifact({ kind: "folder", label: "Open folder", target: "C:\\gone" }, gone);
    assert.equal(r.ok, false);
    assert.match(r.message, /that path does not exist/);
    assert.ok(!gone.calls.some((c) => c[0] === "openPath"), "nothing was opened");

    const refused = fakeDeps({ openPath: async () => { throw new Error("Not allowed to open path"); } });
    const r2 = await O.openArtifact({ kind: "folder", label: "Open folder", target: "C:\\site" }, refused);
    assert.deepEqual(r2, { ok: true });
    assert.deepEqual(refused.calls.at(-1), ["invoke", "desktop_open_url", { url: "C:\\site", browser: null }]);

    const allFail = fakeDeps({
      openPath: async () => { throw new Error("Access is denied"); },
      invoke: async (cmd) => { if (cmd === "path_exists") return true; throw new Error("nope"); },
    });
    const r3 = await O.openArtifact({ kind: "file", label: "Open file", target: "C:\\site\\a.txt" }, allFail);
    assert.equal(r3.ok, false);
    assert.match(r3.message, /access was denied/);
  });

  await test("open: a plain browser (no Tauri) opens web links in a tab and refuses local paths honestly", async () => {
    const web = fakeDeps({ windowOpen: true });
    web.inTauri = () => false;
    assert.deepEqual(await O.openArtifact({ kind: "url", label: "x", target: "https://example.com" }, web), { ok: true });
    const local = fakeDeps();
    local.inTauri = () => false;
    const r = await O.openArtifact(preview, local);
    assert.equal(r.ok, false);
    assert.match(r.message, /desktop app/);
    assert.equal(local.calls.length, 0);
    const blocked = fakeDeps({ windowOpen: false });
    blocked.inTauri = () => false;
    assert.equal((await O.openArtifact({ kind: "url", label: "x", target: "https://example.com" }, blocked)).ok, false, "a blocked popup is not success");
  });

  await test("open: path helpers", () => {
    assert.equal(O.fileUrlToPath("file:///C:/a%20b/c.html"), "C:\\a b\\c.html");
    assert.equal(O.fileUrlToPath("file://server/share/x"), "\\\\server\\share\\x");
    assert.equal(O.fileUrlToPath("C:\\plain\\path"), "C:\\plain\\path");
    assert.equal(O.effectiveKind({ kind: "file", label: "x", target: "https://a.b" }), "url");
    assert.equal(O.effectiveKind({ kind: "preview", label: "x", target: "file:///C:/x.html" }), "preview");
  });

  console.log(`\nPASS \u2014 ${passed} passed, 0 failed`);
})().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
