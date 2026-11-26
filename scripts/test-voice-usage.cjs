/**
 * Privacy/truth regression suite for the Command Center voice-usage rail.
 *
 * Run: node scripts/test-voice-usage.cjs
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

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

const {
  VoiceUsageRail,
  formatVoiceCost,
  voiceBackendRows,
  voiceUsageSummary,
} = loadModule("src/command/VoiceUsageRail.tsx");
const {
  classifyVoiceSnapshot,
  isCurrentVoiceRefresh,
  isNewerVoiceSnapshot,
  phaseForVoiceSnapshot,
} = loadModule("src/command/voiceUsageStore.ts");
const { buildRails } = loadModule("src/command/SupplyPanel.tsx");
const { usageSnapshotPersistenceDegraded } = loadModule("src/command/controlStore.ts");

function snapshot(overrides = {}) {
  return {
    logical_requests: 0,
    provider_attempts: 0,
    pending_attempts: 0,
    successes: 0,
    failures: 0,
    fallback_transitions: 0,
    logical_characters: 0,
    provider_characters: 0,
    last_event_ms: null,
    cost_usd: null,
    cost_basis: "unknown",
    ledger_status: "empty",
    malformed_lines: 0,
    write_failures: 0,
    maintenance_failures: 0,
    backends: [],
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    phase: "ready",
    snapshot: snapshot({
      logical_requests: 1,
      provider_attempts: 1,
      successes: 1,
      logical_characters: 12,
      provider_characters: 12,
      last_event_ms: 1_750_000_000_000,
      ledger_status: "ready",
    }),
    refreshing: false,
    stale: false,
    degraded: false,
    lastLiveMs: 1_750_000_000_000,
    refresh() {},
    ...overrides,
  };
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("voice usage rail");

test("empty, ready, and unavailable snapshots have distinct phases", () => {
  assert.equal(phaseForVoiceSnapshot(snapshot()), "empty");
  assert.equal(
    phaseForVoiceSnapshot(snapshot({ fallback_transitions: 1, ledger_status: "ready" })),
    "ready",
  );
  assert.equal(phaseForVoiceSnapshot(snapshot({ ledger_status: "unavailable" })), "unavailable");
});

test("unknown null cost never renders as a real zero", () => {
  assert.equal(formatVoiceCost(snapshot()), "UNKNOWN");
  assert.equal(formatVoiceCost(snapshot({ cost_usd: 0 })), "UNKNOWN");
});

test("provider-reported zero may render as $0.00", () => {
  assert.equal(
    formatVoiceCost(snapshot({ cost_basis: "provider_reported", cost_usd: 0 })),
    "$0.00",
  );
});

test("summary headlines are the rolling 24-hour backend counts", () => {
  assert.equal(
    voiceUsageSummary(snapshot({
      logical_requests: 8,
      provider_attempts: 12,
      backends: [{
        recent: { attempts: 3, successes: 2, failures: 1, fallback_departures: 1 },
      }],
    })),
    "3 provider attempts today · 2 ok · 1 fail",
  );
});

test("fallback-only backends remain visible even with zero attempts", () => {
  const rows = voiceBackendRows(snapshot({
    backends: [
      {
        backend: "elevenlabs",
        model: "eleven_turbo_v2_5",
        attempts: 0,
        successes: 0,
        failures: 0,
        fallback_departures: 1,
        characters_sent: 0,
        last_event_ms: 20,
      },
      {
        backend: "unused",
        model: "none",
        attempts: 0,
        successes: 0,
        failures: 0,
        fallback_departures: 0,
        characters_sent: 0,
        last_event_ms: 30,
      },
    ],
  }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].backend, "elevenlabs");
});

test("backend rows are newest-first and capped at three", () => {
  const backends = [1, 4, 2, 3].map((last_event_ms) => ({
    backend: `backend-${last_event_ms}`,
    model: `model-${last_event_ms}`,
    attempts: 1,
    successes: 1,
    failures: 0,
    fallback_departures: 0,
    characters_sent: 5,
    last_event_ms,
  }));
  assert.deepEqual(
    voiceBackendRows(snapshot({ backends })).map((row) => row.last_event_ms),
    [4, 3, 2],
  );
});

test("older snapshots cannot overwrite newer counts", () => {
  const current = snapshot({
    last_event_ms: 20,
    logical_requests: 2,
    provider_attempts: 3,
    fallback_transitions: 1,
  });
  assert.equal(isNewerVoiceSnapshot(current, snapshot({ last_event_ms: 19 })), false);
  assert.equal(
    isNewerVoiceSnapshot(current, snapshot({
      last_event_ms: 20,
      logical_requests: 2,
      provider_attempts: 2,
      fallback_transitions: 1,
    })),
    false,
  );
  assert.equal(
    isNewerVoiceSnapshot(current, snapshot({
      last_event_ms: 20,
      logical_requests: 2,
      provider_attempts: 3,
      successes: 1,
      fallback_transitions: 1,
    })),
    true,
  );
});

test("an older equal-count healthy poll cannot clear a newer degraded event", () => {
  const healthy = snapshot({
    logical_requests: 2,
    provider_attempts: 2,
    successes: 2,
    logical_characters: 31,
    provider_characters: 31,
    last_event_ms: 40,
    ledger_status: "ready",
  });
  const degradedEvent = snapshot({
    ...healthy,
    ledger_status: "degraded",
    maintenance_failures: 1,
  });

  const pollGeneration = 7;
  const revisionAtPollStart = 12;
  assert.equal(classifyVoiceSnapshot(healthy, degradedEvent), "accept");
  assert.equal(
    isCurrentVoiceRefresh(pollGeneration, pollGeneration, revisionAtPollStart, revisionAtPollStart + 1),
    false,
  );
  assert.equal(classifyVoiceSnapshot(degradedEvent, healthy), "ignore");
});

test("loading state is reserved and announced without fake spend", () => {
  const html = renderToStaticMarkup(
    React.createElement(VoiceUsageRail, {
      state: state({ phase: "loading", snapshot: null, refreshing: true, lastLiveMs: 0 }),
    }),
  );
  assert.match(html, /SYNCING LOCAL VOICE LEDGER/);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /\$0\.00/);
});

test("empty state says no cloud requests and keeps billing unknown", () => {
  const html = renderToStaticMarkup(
    React.createElement(VoiceUsageRail, {
      state: state({ phase: "empty", snapshot: snapshot() }),
    }),
  );
  assert.match(html, /NO CLOUD VOICE REQUESTS YET/);
  assert.match(html, /COST UNKNOWN/);
  // "billing not queried" became "quota unreachable" when ElevenLabs cannot be
  // reached, because the rail now DOES query - it asks for the character quota,
  // which is the unit ElevenLabs actually meters. The assertion that matters is
  // unchanged: with no provider data, nothing is claimed.
  assert.match(html, /quota unreachable/);
  assert.match(html, /COST UNKNOWN/);
  assert.doesNotMatch(html, /\$0\.00/);
});

test("hard error is generic, recoverable, and makes no provider claim", () => {
  const html = renderToStaticMarkup(
    React.createElement(VoiceUsageRail, {
      state: state({ phase: "unavailable", snapshot: null, lastLiveMs: 0 }),
    }),
  );
  assert.match(html, /VOICE METER UNAVAILABLE/);
  assert.match(html, /No provider was queried/);
  assert.match(html, />RETRY<\/button>/);
});

test("stale error preserves last-good metrics and exposes Retry", () => {
  const html = renderToStaticMarkup(
    React.createElement(VoiceUsageRail, { state: state({ phase: "error", stale: true }) }),
  );
  assert.match(html, /1 lifetime requests · 1 lifetime provider attempts · 12 lifetime chars/);
  assert.match(html, /0 provider attempts today · 0 ok · 0 fail/);
  assert.match(html, /refresh failed/);
  assert.match(html, />RETRY<\/button>/);
});

test("degraded and pending states are explicit", () => {
  const degraded = snapshot({
    logical_requests: 1,
    provider_attempts: 1,
    pending_attempts: 1,
    logical_characters: 10,
    provider_characters: 10,
    last_event_ms: 30,
    ledger_status: "degraded",
    malformed_lines: 2,
    write_failures: 1,
    maintenance_failures: 1,
  });
  const html = renderToStaticMarkup(
    React.createElement(VoiceUsageRail, {
      state: state({ phase: "ready", snapshot: degraded, degraded: true }),
    }),
  );
  assert.match(html, /LEDGER DEGRADED · 2 malformed lines ignored · 1 write failure · 1 maintenance issue/);
  assert.match(html, /1 PROVIDER ATTEMPT HAS NO RECORDED RESULT/);
});

test("backend accessibility text retains the full model and outcomes", () => {
  const detailed = snapshot({
    logical_requests: 1,
    provider_attempts: 1,
    successes: 1,
    logical_characters: 17,
    provider_characters: 17,
    last_event_ms: 50,
    ledger_status: "ready",
    backends: [{
      backend: "groq",
      model: "canopylabs/orpheus-v1-english",
      attempts: 1,
      successes: 1,
      failures: 0,
      fallback_departures: 0,
      characters_sent: 17,
      last_event_ms: 50,
      recent: { attempts: 1, successes: 1, failures: 0, fallback_departures: 0 },
      last_failure_ms: null,
      last_failure_reason: null,
    }],
  });
  const html = renderToStaticMarkup(
    React.createElement(VoiceUsageRail, { state: state({ snapshot: detailed }) }),
  );
  assert.match(html, /canopylabs\/orpheus-v1-english/);
  assert.match(html, /1 attempts, 1 successful, 0 failed/);
});

test("older failures are muted with recency and unknown-reason copy", () => {
  const oldFailure = snapshot({
    logical_requests: 18,
    provider_attempts: 18,
    failures: 4,
    logical_characters: 120,
    provider_characters: 120,
    last_event_ms: 1_758_000_000_000,
    ledger_status: "ready",
    backends: [{
      backend: "openai",
      model: "gpt-4o-mini-tts",
      attempts: 18,
      successes: 14,
      failures: 4,
      fallback_departures: 6,
      characters_sent: 120,
      last_event_ms: 1_758_000_000_000,
      recent: { attempts: 0, successes: 0, failures: 0, fallback_departures: 0 },
      last_failure_ms: 1_758_000_000_000,
      last_failure_reason: null,
    }],
  });
  const html = renderToStaticMarkup(
    React.createElement(VoiceUsageRail, { state: state({ snapshot: oldFailure }) }),
  );
  assert.match(html, /0 fail today · last fail/);
  assert.match(html, /reason not recorded/);
  assert.doesNotMatch(html, /#e04355/);
  assert.match(html, /Lifetime: 18 attempts, 14 successful, 4 failed/);
});

test("recent failures retain the warning color and recorded reason", () => {
  const recentFailure = snapshot({
    logical_requests: 1,
    provider_attempts: 1,
    failures: 1,
    logical_characters: 12,
    provider_characters: 12,
    last_event_ms: Date.now(),
    ledger_status: "ready",
    backends: [{
      backend: "openai",
      model: "gpt-4o-mini-tts",
      attempts: 1,
      successes: 0,
      failures: 1,
      fallback_departures: 1,
      characters_sent: 12,
      last_event_ms: Date.now(),
      recent: { attempts: 1, successes: 0, failures: 1, fallback_departures: 1 },
      last_failure_ms: Date.now(),
      last_failure_reason: "credit refused",
    }],
  });
  const html = renderToStaticMarkup(
    React.createElement(VoiceUsageRail, { state: state({ snapshot: recentFailure }) }),
  );
  assert.match(html, /1 fail today/);
  assert.match(html, /credit refused/);
  assert.match(html, /#e04355/);
});

test("voice telemetry never enters quota rails or the tightest calculation", () => {
  const { rails, tightest } = buildRails([], 0);
  assert.equal(rails.some((rail) => rail.name.includes("VOICE BACKENDS")), false);
  assert.equal(tightest, null);
});

test("degraded shared persistence is visible and excluded from tightest decisions", () => {
  const { rails, tightest } = buildRails([{
    key: "codex",
    label: "Codex",
    spend: 0,
    unit: "on plan",
    status: "est",
    models: [],
    isSubscription: true,
    persistenceDegraded: true,
    plan: [{
      label: "Codex 5h window",
      window: "5h",
      used: 80,
      limit: 100,
      unit: "percent",
      estimated: false,
      basis: "real",
    }],
  }], 1_750_000_000_000);
  const codex = rails.find((rail) => rail.name === "CODEX");
  assert.equal(codex.freshness.text, "ledger degraded");
  assert.equal(tightest, null);
});

test("degraded wire snapshots are rejected as last-good cache candidates", () => {
  const healthy = [{ persistence_degraded: false }];
  const degraded = [{ persistence_degraded: true }];
  assert.equal(usageSnapshotPersistenceDegraded(healthy), false);
  assert.equal(usageSnapshotPersistenceDegraded(degraded), true);
});

console.log(`\nPASS — ${passed} passed, 0 failed`);
