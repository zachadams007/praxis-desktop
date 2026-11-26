/**
 * Supply live meters - Cursor TOTAL/API percents + RELOAD order.
 *
 * Run: node scripts/test-supply-live.cjs
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");

function loadModule(relativePath) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, relativePath)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    write: false,
    alias: { "@": path.join(root, "src") },
    external: ["react", "react-dom", "@tauri-apps/api/*"],
    logLevel: "silent",
  });
  const mod = { exports: {} };
  const execute = new Function("require", "module", "exports", result.outputFiles[0].text);
  execute(require, mod, mod.exports);
  return mod.exports;
}

const { buildRails, reloadSupply, fmtReloadClock } = loadModule("src/command/SupplyPanel.tsx");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (err) {
    console.error("  ✗ " + name);
    throw err;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (err) {
    console.error("  ✗ " + name);
    throw err;
  }
}

console.log("Supply live meters");

test("Cursor TOTAL 23% / API 46% from live percents (no 2000/2000 bar)", () => {
  const { rails } = buildRails(
    [
      {
        key: "cursor",
        label: "Cursor",
        spend: 0,
        unit: "on plan",
        status: "live",
        models: [],
        isSubscription: true,
        plan: [
          {
            label: "Cursor · pro · TOTAL",
            window: "credits",
            used: 22.766666666666666,
            limit: 100,
            unit: "percent",
            estimated: false,
            basis: "real",
            owner: "Lens",
            resetsAt: "2026-10-02T15:00:15.000Z",
            account: "zach@example.com",
          },
          {
            label: "Cursor · pro · API",
            window: "credits",
            used: 45.53333333333333,
            limit: 100,
            unit: "percent",
            estimated: false,
            basis: "real",
            owner: "Lens",
            resetsAt: "2026-10-02T15:00:15.000Z",
            account: "zach@example.com",
          },
        ],
      },
    ],
    Date.now(),
  );
  const cursor = rails.find((r) => r.name === "CURSOR");
  assert.ok(cursor);
  assert.equal(cursor.bars.length, 2);
  assert.equal(cursor.bars[0].label, "TOTAL");
  assert.equal(cursor.bars[0].valueText, "23%");
  assert.equal(cursor.bars[1].label, "API");
  assert.equal(cursor.bars[1].valueText, "46%");
  assert.match(cursor.note, /pro/i);
  assert.match(cursor.note, /resets/i);
  assert.match(cursor.note, /zach@example.com/);
  assert.equal(
    cursor.bars.some((b) => b.valueText.includes("2000")),
    false,
  );
});

function cursorPoolSource() {
  return {
    key: "cursor",
    label: "Cursor",
    spend: 0,
    unit: "on plan",
    status: "live",
    models: [],
    isSubscription: true,
    plan: [
      { label: "Cursor · pro · TOTAL", window: "credits", used: 76, limit: 100, unit: "percent", estimated: false, basis: "real", resetsAt: "2026-10-02T15:00:15.000Z" },
      { label: "Cursor · pro · CURSOR MODELS", window: "credits", used: 100, limit: 100, unit: "percent", estimated: false, basis: "real", resetsAt: "2026-10-02T15:00:15.000Z" },
      { label: "Cursor · pro · API", window: "credits", used: 52, limit: 100, unit: "percent", estimated: false, basis: "real", resetsAt: "2026-10-02T15:00:15.000Z" },
    ],
  };
}

test("allowed API pool is Cursor's effective rail while own models stay muted", () => {
  const pool = {
    models_pool_pct: 100,
    api_pool_pct: 52,
    resets_at_ms: Date.parse("2026-10-02T15:00:15.000Z"),
    exhausted: true,
    api_pool_allowed: true,
    effective_pct: 52,
    note: "",
  };
  const { rails, tightest } = buildRails([cursorPoolSource()], Date.now(), pool);
  const cursor = rails.find((rail) => rail.name === "CURSOR");
  const own = cursor.bars.find((bar) => bar.label === "OWN MODELS");
  assert.equal(tightest.name, "CURSOR");
  assert.equal(tightest.pct, 52);
  assert.match(own.mutedNote, /used up until .*Oct 2/i);
  assert.match(own.mutedNote, /Quill on API pool/);
  assert.equal(own.includeInTightest, false);
});

test("disallowed API pool leaves the exhausted own-model rail effective and red", () => {
  const pool = {
    models_pool_pct: 100,
    api_pool_pct: 52,
    resets_at_ms: Date.parse("2026-10-02T15:00:15.000Z"),
    exhausted: true,
    api_pool_allowed: false,
    effective_pct: 100,
    note: "paused",
  };
  const { rails, tightest } = buildRails([cursorPoolSource()], Date.now(), pool);
  const cursor = rails.find((rail) => rail.name === "CURSOR");
  assert.equal(tightest.name, "CURSOR");
  assert.equal(tightest.pct, 100);
  assert.equal(cursor.bars.some((bar) => bar.mutedNote), false);
});

test("Claude auth-expired sentinel draws no real bar", () => {
  const { rails } = buildRails(
    [
      {
        key: "claude",
        label: "Claude",
        spend: 0,
        unit: "on plan",
        status: "est",
        models: [],
        isSubscription: true,
        plan: [
          {
            label: "Claude sign-in expired - run claude /login",
            window: "auth",
            used: 0,
            limit: 0,
            unit: "percent",
            estimated: true,
            basis: "estimated",
          },
        ],
      },
    ],
    0,
  );
  const claude = rails.find((r) => r.name === "Claude" || r.name.startsWith("Claude"));
  assert.ok(claude);
  assert.equal(claude.bars.length, 0);
  assert.match(claude.note, /sign-in expired/i);
});

test("fmtReloadClock includes seconds and capital meridian", () => {
  // 16:12:05 local → 4:12:05P
  const ms = new Date(2026, 8, 14, 16, 12, 5).getTime();
  assert.equal(fmtReloadClock(ms), "4:12:05P");
});

test("Codex LIMIT REACHED note stays verbatim (not lowercased)", () => {
  const { rails } = buildRails(
    [
      {
        key: "codex",
        label: "Codex",
        spend: 0,
        unit: "on plan",
        status: "live",
        models: [],
        isSubscription: true,
        plan: [
          {
            label: "Codex · 5h window · LIMIT REACHED - returns 2:59 PM",
            window: "5h",
            used: 100,
            limit: 100,
            unit: "percent",
            estimated: false,
            basis: "real",
            owner: "Vega",
            resetsAt: "2026-09-15T18:59:20.000Z",
          },
          {
            label: "Codex · weekly",
            window: "weekly",
            used: 48,
            limit: 100,
            unit: "percent",
            estimated: false,
            basis: "real",
            owner: "Vega",
          },
        ],
      },
    ],
    Date.now(),
  );
  const codex = rails.find((r) => r.name === "CODEX");
  assert.ok(codex);
  assert.match(codex.note, /LIMIT REACHED - returns 2:59 PM/);
  assert.equal(codex.bars[0].label, "5H WINDOW");
  assert.equal(codex.bars[0].valueText, "100%");
  assert.equal(codex.bars[1].label, "WEEKLY");
  assert.equal(codex.bars[1].valueText, "48%");
});

// 2026-10-04: Anthropic refused Claude Code for the account; the rail showed a quiet
// "est. caps" estimate and the header read RAILS NOMINAL.
const claudeSource = (lead) => ({
  key: "claude", label: "Claude Pro", spend: 0, unit: "on plan", status: "live", models: [], isSubscription: true,
  plan: [
    ...lead,
    { label: "Claude Pro · 5h window · est.", window: "5h", used: 176, limit: 450, unit: "msgs", estimated: true, basis: "estimated", owner: "Forge" },
    { label: "Claude Pro · weekly · est.", window: "weekly", used: 1613, limit: 9000, unit: "msgs", estimated: true, basis: "estimated", owner: "Forge" },
  ],
});
test("a refused Claude rail says so first, marks its bars as estimates, and raises the header alert", () => {
  const since = new Date(2026, 9, 4, 13, 32).toISOString();
  const { rails, tightest, alerts } = buildRails([claudeSource([
    { label: "The vendor is refusing Claude Code · Forge benched", window: "refused", used: 0, limit: 0, unit: "percent", estimated: true, basis: "estimated", owner: "Forge", since },
  ])], Date.now());
  const claude = rails.find((r) => r.name === "Claude Pro");
  assert.match(claude.note, /^Anthropic: refused · est\. bars · since 1:32p · Forge benched$/);
  assert.equal(claude.bars.length, 2, "the estimate bars stay visible");
  assert.equal(claude.freshness.text, "refused");
  assert.equal(claude.includeInTightest, false);
  assert.deepEqual(alerts, ["CLAUDE REFUSED"]);
  assert.equal(tightest, null, "an estimate never becomes the tightest live rail");
});
test("a paused meter says when Anthropic lets it resume", () => {
  const until = new Date(2026, 9, 4, 14, 30).toISOString();
  const { rails, alerts } = buildRails([claudeSource([
    { label: "The live meter is paused", window: "paused", used: 0, limit: 0, unit: "percent", estimated: true, basis: "estimated", owner: "Forge", resetsAt: until },
  ])], Date.now());
  const claude = rails.find((r) => r.name === "Claude Pro");
  assert.equal(claude.note, "live meter paused by Anthropic until 2:30p · est. bars");
  assert.equal(claude.freshness.text, "paused");
  assert.equal(claude.bars.length, 2);
  assert.deepEqual(alerts, [], "a paused meter is not a dead rail");
});

(async () => {
  await testAsync("reloadSupply awaits refresh_live_state before refresh", async () => {
    const order = [];
    await reloadSupply(
      async () => {
        order.push("live");
        await new Promise((r) => setTimeout(r, 5));
      },
      async () => {
        order.push("usage");
      },
    );
    assert.deepEqual(order, ["live", "usage"]);
  });

  console.log(`\nPASS — ${passed} passed, 0 failed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
