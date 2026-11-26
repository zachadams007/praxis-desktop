/** Fail-closed regressions for paid OpenAI Realtime usage accounting. */
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const result = esbuild.buildSync({
  entryPoints: [path.join(root, "src/voice/realtimeTransport.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  write: false,
  alias: { "@": path.join(root, "src") },
  external: ["@tauri-apps/api/*"],
  logLevel: "silent",
});
const mod = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)(
  require,
  mod,
  mod.exports,
);
const { RealtimeTransport, extractUsage } = mod.exports;

// The REAL tool list, bundled from source rather than restated here.
//
// This fixture used to hardcode seven names. The session grew to fifteen when the
// desktop tools landed (open_app, click, screenshot, window_control...), the list
// was never updated, and `validateSessionConfigurationAcknowledgement` threw on
// every run - so the whole suite died at startup and stayed "a known crash" for
// weeks. A fixture that restates what the code already knows will drift again;
// this one cannot.
const toolsBundle = esbuild.buildSync({
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
const toolsMod = { exports: {} };
new Function("require", "module", "exports", toolsBundle.outputFiles[0].text)(
  require,
  toolsMod,
  toolsMod.exports,
);

function officialUsage(overrides = {}) {
  return {
    input_tokens: 132,
    output_tokens: 121,
    input_token_details: {
      text_tokens: 119,
      audio_tokens: 13,
      image_tokens: 0,
      cached_tokens: 64,
      cached_tokens_details: { text_tokens: 64, audio_tokens: 0, image_tokens: 0 },
    },
    output_token_details: { text_tokens: 30, audio_tokens: 91 },
    ...overrides,
  };
}

const EXPECTED_TOOL_NAMES = toolsMod.exports.HYBRID_TOOL_SPECS.map((t) => t.name);
assert.ok(
  EXPECTED_TOOL_NAMES.length >= 7 && EXPECTED_TOOL_NAMES.includes("halt"),
  `tool list looks wrong: ${JSON.stringify(EXPECTED_TOOL_NAMES)}`,
);

function mintedSession(overrides = {}) {
  return {
    model: "gpt-realtime-2",
    voice: "cedar",
    max_output_tokens: 256,
    post_instruction_tokens: 4000,
    reasoning_effort: "low",
    ...overrides,
  };
}

function officialSessionAck() {
  return {
    type: "session.updated",
    session: {
      type: "realtime",
      model: "gpt-realtime-2",
      max_output_tokens: 256,
      reasoning: { effort: "low" },
      audio: {
        input: {
          turn_detection: {
            type: "server_vad",
            create_response: false,
            interrupt_response: true,
          },
        },
        output: { voice: "cedar" },
      },
      tools: EXPECTED_TOOL_NAMES.map((name) => ({ type: "function", name })),
      tool_choice: "auto",
    },
  };
}

function testTransport() {
  const transport = new RealtimeTransport();
  // Tests exercise committed-audio events but should never retain the
  // production two-minute timer after their assertions finish.
  transport.resetIdleTimer = () => {};
  return transport;
}

function armToolResponse(transport, responseId, generation = transport.toolGeneration) {
  transport.responseToolGenerations.set(responseId, generation);
  return responseId;
}

function markSessionConfigurationAccepted(transport) {
  transport.sessionConfigurationAcceptedGeneration = transport.connectGeneration;
}

async function admitToolResponse(transport, responseId) {
  transport.accountingSessionId = `lease-${responseId}`;
  markSessionConfigurationAccepted(transport);
  transport.invokeCommand = async (command) => {
    assert.equal(command, "authorize_realtime_response");
    return 0.25;
  };
  transport.onEvent(JSON.stringify({ type: "input_audio_buffer.committed" }));
  await Promise.resolve();
  await Promise.resolve();
  transport.onEvent(JSON.stringify({ type: "response.created", response: { id: responseId } }));
  assert.equal(transport.responseToolGenerations.get(responseId), transport.toolGeneration);
  return responseId;
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

void (async () => {
  console.log("realtime usage guard");

  await test("session.update declares type, reasoning, and a correlated event ID", () => {
    const transport = testTransport();
    let update = null;
    transport.send = (event) => {
      update = event;
      return true;
    };
    const sent = transport.configureSession(mintedSession(), "praxis-test-update");
    assert.equal(sent, true);
    assert.equal(update?.event_id, "praxis-test-update");
    assert.equal(update?.type, "session.update");
    assert.equal(update?.session?.type, "realtime");
    assert.deepEqual(update?.session?.reasoning, { effort: "low" });
  });

  await test("connect gate resolves only after a matching safety-critical session.updated contract", async () => {
    const transport = testTransport();
    const sent = [];
    transport.connectGeneration = 7;
    transport.dc = {
      readyState: "open",
      send(payload) { sent.push(JSON.parse(payload)); },
    };
    const gate = transport.configureSessionAndWait(mintedSession(), 7);
    let settled = false;
    void gate.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.match(sent[0]?.event_id ?? "", /^praxis_session_update_7_/);
    transport.dc.onopen();
    assert.equal(sent.length, 1);
    transport.onEvent(JSON.stringify(officialSessionAck()));
    await gate;
    assert.equal(settled, true);
  });

  const acknowledgementMismatches = [
    ["missing session contract", (ack) => { delete ack.session; }],
    ["session type", (ack) => { ack.session.type = "transcription"; }],
    ["minted model", (ack) => { ack.session.model = "different-model"; }],
    ["maximum output tokens", (ack) => { ack.session.max_output_tokens = 512; }],
    ["reasoning effort", (ack) => { ack.session.reasoning.effort = "medium"; }],
    ["output voice", (ack) => { ack.session.audio.output.voice = "marin"; }],
    ["automatic response creation", (ack) => {
      ack.session.audio.input.turn_detection.create_response = true;
    }],
    ["native interruption", (ack) => {
      ack.session.audio.input.turn_detection.interrupt_response = false;
    }],
    ["tool choice", (ack) => { ack.session.tool_choice = "required"; }],
    ["missing function tool", (ack) => { ack.session.tools.pop(); }],
    ["unexpected function tool", (ack) => {
      ack.session.tools.push({ type: "function", name: "unexpected_tool" });
    }],
  ];
  let mismatchGeneration = 20;
  for (const [label, mutate] of acknowledgementMismatches) {
    await test(`connect gate rejects session.updated with mismatched ${label}`, async () => {
      const transport = testTransport();
      const sent = [];
      const generation = mismatchGeneration;
      mismatchGeneration += 1;
      transport.connectGeneration = generation;
      transport.dc = {
        readyState: "open",
        send(payload) { sent.push(JSON.parse(payload)); },
      };
      const gate = transport.configureSessionAndWait(mintedSession(), generation);
      const acknowledgement = officialSessionAck();
      mutate(acknowledgement);
      transport.onEvent(JSON.stringify(acknowledgement));
      await assert.rejects(gate, /session acknowledgement did not (?:include|match)/i);
      assert.equal(transport.pendingSessionConfiguration, null);
      assert.deepEqual(sent.map((event) => event.type), ["session.update"]);
    });
  }

  await test("connect gate accepts the exact tool roster if the provider reorders it", async () => {
    const transport = testTransport();
    transport.connectGeneration = 31;
    transport.dc = { readyState: "open", send() {} };
    const gate = transport.configureSessionAndWait(mintedSession(), 31);
    const acknowledgement = officialSessionAck();
    acknowledgement.session.tools.reverse();
    transport.onEvent(JSON.stringify(acknowledgement));
    await gate;
    assert.equal(transport.pendingSessionConfiguration, null);
  });

  await test("audio committed before session acceptance is discarded, never authorized or replayed", async () => {
    const transport = testTransport();
    const sent = [];
    const invoked = [];
    transport.connectGeneration = 40;
    transport.accountingSessionId = "lease-pre-ack-discard";
    transport.dc = {
      readyState: "open",
      send(payload) { sent.push(JSON.parse(payload)); },
    };
    transport.invokeCommand = async (command) => {
      invoked.push(command);
      return 0.25;
    };
    const gate = transport.configureSessionAndWait(mintedSession(), 40);

    transport.onEvent(JSON.stringify({ type: "input_audio_buffer.committed" }));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(invoked, []);
    assert.equal(sent.some((event) => event.type === "response.create"), false);
    assert.equal(transport.queuedResponseCreate, false);

    transport.onEvent(JSON.stringify(officialSessionAck()));
    await gate;
    await Promise.resolve();
    assert.deepEqual(invoked, []);
    assert.equal(sent.some((event) => event.type === "response.create"), false);
  });

  await test("pre-ack commit plus invalid echo stays unbilled and releases the exact clean lease", async () => {
    const transport = testTransport();
    const sent = [];
    const invoked = [];
    const released = [];
    const uncertain = [];
    transport.connectGeneration = 41;
    transport.accountingSessionId = "lease-invalid-clean";
    transport.dc = {
      readyState: "open",
      send(payload) { sent.push(JSON.parse(payload)); },
      close() {},
    };
    transport.invokeCommand = async (command) => {
      invoked.push(command);
      return 0.25;
    };
    transport.releaseAccountingSession = async (accountingSessionId) => {
      released.push(accountingSessionId);
    };
    transport.markUsageUncertain = async (accountingSessionId) => {
      uncertain.push(accountingSessionId);
    };
    const gate = transport.configureSessionAndWait(mintedSession(), 41);
    transport.onEvent(JSON.stringify({ type: "input_audio_buffer.committed" }));
    const invalid = officialSessionAck();
    invalid.session.model = "different-model";
    transport.onEvent(JSON.stringify(invalid));
    await assert.rejects(gate, /did not match/i);
    assert.deepEqual(invoked, []);
    assert.equal(sent.some((event) => event.type === "response.create"), false);

    transport.disconnect();
    await Promise.resolve();
    assert.deepEqual(released, ["lease-invalid-clean"]);
    assert.deepEqual(uncertain, []);
  });

  await test("audio committed after a valid echo authorizes and creates exactly one response", async () => {
    const transport = testTransport();
    const sent = [];
    const invoked = [];
    transport.connectGeneration = 42;
    transport.accountingSessionId = "lease-post-ack";
    transport.dc = {
      readyState: "open",
      send(payload) { sent.push(JSON.parse(payload)); },
    };
    transport.invokeCommand = async (command) => {
      invoked.push(command);
      assert.equal(command, "authorize_realtime_response");
      return 0.25;
    };
    const gate = transport.configureSessionAndWait(mintedSession(), 42);
    transport.onEvent(JSON.stringify(officialSessionAck()));
    await gate;
    sent.length = 0;

    transport.onEvent(JSON.stringify({ type: "input_audio_buffer.committed" }));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(invoked, ["authorize_realtime_response"]);
    assert.deepEqual(sent, [{ type: "response.create" }]);
  });

  await test("in-flight authorization cannot send after echo mismatch or generation teardown", async () => {
    for (const mode of ["mismatch", "teardown"]) {
      const transport = testTransport();
      const sent = [];
      let releaseAuthorization;
      let noteAuthorizationStarted;
      const authorizationStarted = new Promise((resolve) => { noteAuthorizationStarted = resolve; });
      const authorization = new Promise((resolve) => { releaseAuthorization = resolve; });
      const generation = mode === "mismatch" ? 43 : 44;
      transport.connectGeneration = generation;
      transport.accountingSessionId = `lease-in-flight-${mode}`;
      transport.dc = {
        readyState: "open",
        send(payload) { sent.push(JSON.parse(payload)); },
        close() {},
      };
      transport.releaseAccountingSession = async () => {};
      transport.invokeCommand = async (command) => {
        assert.equal(command, "authorize_realtime_response");
        noteAuthorizationStarted();
        return authorization;
      };
      const gate = transport.configureSessionAndWait(mintedSession(), generation);
      transport.onEvent(JSON.stringify(officialSessionAck()));
      await gate;
      sent.length = 0;
      transport.onEvent(JSON.stringify({ type: "input_audio_buffer.committed" }));
      await authorizationStarted;

      if (mode === "mismatch") {
        const reconfiguration = transport.configureSessionAndWait(mintedSession(), generation);
        const invalid = officialSessionAck();
        invalid.session.reasoning.effort = "medium";
        transport.onEvent(JSON.stringify(invalid));
        await assert.rejects(reconfiguration, /did not match/i);
      } else {
        transport.disconnect();
      }
      releaseAuthorization(0.25);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(
        sent.some((event) => event.type === "response.create"),
        false,
        `${mode} allowed response.create after authorization`,
      );
      if (mode === "mismatch") transport.disconnect();
    }
  });

  await test("invalid create_response echo quarantines its exact lease before a synthetic response", async () => {
    const transport = testTransport();
    const sent = [];
    const invoked = [];
    const released = [];
    const uncertain = [];
    transport.connectGeneration = 45;
    transport.accountingSessionId = "lease-auto-response-uncertain";
    transport.dc = {
      readyState: "open",
      send(payload) { sent.push(JSON.parse(payload)); },
      close() {},
    };
    transport.invokeCommand = async (command) => {
      invoked.push(command);
      return 0.25;
    };
    transport.releaseAccountingSession = async (accountingSessionId) => {
      released.push(accountingSessionId);
    };
    transport.markUsageUncertain = async (accountingSessionId) => {
      uncertain.push(accountingSessionId);
    };
    const gate = transport.configureSessionAndWait(mintedSession(), 45);
    transport.onEvent(JSON.stringify({ type: "input_audio_buffer.committed" }));
    const invalid = officialSessionAck();
    invalid.session.audio.input.turn_detection.create_response = true;
    transport.onEvent(JSON.stringify(invalid));
    await assert.rejects(gate, /create_response/i);
    assert.equal(transport.hasUnaccountedResponse(), true);

    // Match connect()'s failure cleanup before a provider-created response can
    // arrive. The uncertainty marker must win; a clean close is forbidden.
    transport.disconnect();
    await Promise.resolve();
    transport.onEvent(JSON.stringify({
      type: "response.created",
      response: { id: "provider-auto-response" },
    }));
    await Promise.resolve();
    assert.deepEqual(invoked, []);
    assert.deepEqual(uncertain, ["lease-auto-response-uncertain"]);
    assert.deepEqual(released, []);
    assert.equal(sent.some((event) => event.type === "response.create"), false);
  });

  await test("retired data channel cannot acknowledge the current connection", () => {
    const transport = testTransport();
    transport.connectGeneration = 11;
    let delivered = 0;
    transport.onEvent = () => { delivered += 1; };
    const retired = {};
    transport.bindDataChannel(retired, 11);
    transport.dc = {};
    retired.onmessage({ data: JSON.stringify({ type: "session.updated" }) });
    assert.equal(delivered, 0);
  });

  await test("matching provider error rejects the session configuration gate", async () => {
    const transport = testTransport();
    const sent = [];
    transport.connectGeneration = 8;
    transport.dc = {
      readyState: "open",
      send(payload) { sent.push(JSON.parse(payload)); },
    };
    const gate = transport.configureSessionAndWait(mintedSession(), 8);
    const eventId = sent[0].event_id;
    transport.onEvent(JSON.stringify({
      type: "error",
      error: { event_id: eventId, message: "invalid adjacent field" },
    }));
    await assert.rejects(gate, /invalid adjacent field/i);
    assert.equal(transport.pendingSessionConfiguration, null);
  });

  await test("session configuration timeout rejects and clears the pending gate", async () => {
    const transport = testTransport();
    transport.connectGeneration = 9;
    transport.sessionConfigurationTimeoutMs = 1;
    transport.dc = { readyState: "open", send() {} };
    const gate = transport.configureSessionAndWait(mintedSession(), 9);
    await assert.rejects(gate, /did not acknowledge/i);
    assert.equal(transport.pendingSessionConfiguration, null);
  });

  await test("teardown rejects an in-flight configuration and a late ack cannot revive it", async () => {
    const transport = testTransport();
    transport.connectGeneration = 10;
    transport.dc = { readyState: "open", send() {}, close() {} };
    const gate = transport.configureSessionAndWait(mintedSession(), 10);
    transport.disconnect();
    await assert.rejects(gate, /connect was cancelled/i);
    assert.equal(transport.pendingSessionConfiguration, null);
    transport.onEvent(JSON.stringify({ type: "session.updated", session: { type: "realtime" } }));
    assert.equal(transport.connected, false);
  });

  await test("unmatched recoverable provider error leaves the configuration gate pending", async () => {
    const transport = testTransport();
    const sent = [];
    transport.connectGeneration = 12;
    transport.dc = {
      readyState: "open",
      send(payload) { sent.push(JSON.parse(payload)); },
    };
    const gate = transport.configureSessionAndWait(mintedSession(), 12);
    transport.onEvent(JSON.stringify({
      type: "error",
      error: { event_id: "different-client-event", message: "no response to cancel" },
    }));
    assert.notEqual(transport.pendingSessionConfiguration, null);
    transport.onEvent(JSON.stringify(officialSessionAck()));
    await gate;
    assert.equal(sent.length, 1);
  });

  await test("tap interruption cancels then clears WebRTC audio without permanent pause", () => {
    const transport = testTransport();
    const sent = [];
    let pauses = 0;
    let plays = 0;
    transport.audioEl = {
      paused: false,
      pause() { pauses += 1; },
      play() { plays += 1; return Promise.resolve(); },
    };
    transport.dc = { readyState: "open", send(payload) { sent.push(JSON.parse(payload)); } };
    transport.speaking = true;
    transport.stopSpeaking();
    assert.deepEqual(sent.slice(0, 2), [
      { type: "response.cancel" },
      { type: "output_audio_buffer.clear" },
    ]);
    assert.equal(pauses, 0);

    transport.audioEl.paused = true;
    transport.onEvent(JSON.stringify({
      type: "response.output_audio.delta",
      response_id: "resp-after-interrupt",
    }));
    assert.equal(plays, 1);
  });

  await test("extracts official cached token details by modality", () => {
    assert.deepEqual(extractUsage(officialUsage()), {
      audio_input_tokens: 13,
      cached_audio_input_tokens: 0,
      text_input_tokens: 119,
      cached_text_input_tokens: 64,
      image_input_tokens: 0,
      audio_output_tokens: 91,
      text_output_tokens: 30,
    });
  });

  await test("images, aggregate cache totals, and reasoning residuals are priced", () => {
    assert.deepEqual(extractUsage({
      input_tokens: 155,
      output_tokens: 130,
      input_token_details: {
        text_tokens: 119,
        audio_tokens: 13,
        image_tokens: 18,
        cached_tokens: 64,
        cached_tokens_details: { text_tokens: 64, audio_tokens: 0, image_tokens: 0 },
      },
      output_token_details: { text_tokens: 30, audio_tokens: 91 },
    }), {
      audio_input_tokens: 13,
      cached_audio_input_tokens: 0,
      text_input_tokens: 124,
      cached_text_input_tokens: 64,
      image_input_tokens: 18,
      audio_output_tokens: 91,
      text_output_tokens: 39,
    });
    assert.deepEqual(extractUsage({
      input_tokens: 20,
      output_tokens: 8,
      input_token_details: { audio_tokens: 12, text_tokens: 8, cached_tokens: 5 },
      output_token_details: { audio_tokens: 8 },
    }), {
      audio_input_tokens: 12,
      cached_audio_input_tokens: 0,
      text_input_tokens: 8,
      cached_text_input_tokens: 0,
      image_input_tokens: 0,
      audio_output_tokens: 8,
      text_output_tokens: 0,
    });
    assert.deepEqual(extractUsage({ input_tokens: 7, output_tokens: 3 }), {
      audio_input_tokens: 0,
      cached_audio_input_tokens: 0,
      text_input_tokens: 7,
      cached_text_input_tokens: 0,
      image_input_tokens: 0,
      audio_output_tokens: 0,
      text_output_tokens: 3,
    });
  });

  await test("only malformed usage values are rejected", () => {
    assert.equal(extractUsage(undefined), null);
    assert.equal(extractUsage([]), null);
    assert.deepEqual(extractUsage({}), {
      audio_input_tokens: 0,
      cached_audio_input_tokens: 0,
      text_input_tokens: 0,
      cached_text_input_tokens: 0,
      image_input_tokens: 0,
      audio_output_tokens: 0,
      text_output_tokens: 0,
    });
    assert.equal(extractUsage({
      input_token_details: { audio_tokens: Infinity },
      output_token_details: { audio_tokens: Number.NaN },
    }), null);
    assert.equal(extractUsage({
      input_token_details: { audio_tokens: -1 },
      output_token_details: { audio_tokens: 8.5 },
    }), null);
    assert.equal(extractUsage(officialUsage({ input_tokens: 131 })), null);
  });

  // An accounting gap is not a reason to stop talking.
  //
  // `extractUsage` now accepts valid image/cache/ reasoning shapes, while genuinely malformed
  // provider values still take this explicit unmetered path.
  //
  // The trade is explicit: one turn's tokens go uncounted, so the session's spend
  // estimate is a floor rather than a total, and that is said in the console. The
  // alternative was losing the conversation.
  await test("response.done without readable usage keeps the session alive", async () => {
    const transport = testTransport();
    let reason = "";
    let markedUncertain = false;
    transport.accountingSessionId = "lease-missing-usage";
    transport.markUsageUncertain = async () => {
      markedUncertain = true;
    };
    transport.onSessionEnd = (message) => { reason = message; };
    transport.noteResponseStarted({ response: { id: "resp-missing-usage" } });
    await transport.handleResponseDone({ response: { id: "resp-missing-usage" } });
    await Promise.resolve();
    assert.equal(reason, "", "the session must not end over an unreadable usage block");
    assert.equal(transport.unmeteredTurns, 1, "the turn is counted as unmetered");

    // Crucially it must NOT latch. `markUsageUncertain` also sets
    // `realtimeUsageUncertainLatch` and blanks `readyCache.ready`, which disables
    // Realtime for every FUTURE session - the orphaned-marker latch that had Atlas
    // silently running on the local voice for weeks.
    assert.equal(markedUncertain, false, "one unreadable turn must not disable the feature");

    // The response is booked as handled, so the session-end orphan check - which is
    // what the hard latch genuinely exists for - does not fire on it either.
    let latchedOnDisconnect = false;
    transport.markUsageUncertain = async () => { latchedOnDisconnect = true; };
    transport.releaseAccountingSession = async () => {};
    transport.disconnect();
    await Promise.resolve();
    assert.equal(latchedOnDisconnect, false, "a counted turn is not an orphaned response");
  });

  await test("unreadable usage logs at most 600 raw JSON characters once per session", async () => {
    const transport = testTransport();
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      for (const id of ["resp-raw-one", "resp-raw-two"]) {
        transport.noteResponseStarted({ response: { id } });
        await transport.handleResponseDone({
          response: {
            id,
            usage: { input_tokens: -1, provider_extra: "x".repeat(1_000) },
          },
        });
      }
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /Raw usage: /);
    assert.doesNotMatch(warnings[1], /Raw usage: /);
    assert.equal(warnings[0].split("Raw usage: ")[1].length, 600);
  });

  await test("disconnect with an unaccounted response marks usage uncertain", async () => {
    const transport = testTransport();
    let markedUncertain = false;
    let released = false;
    transport.markUsageUncertain = async () => {
      markedUncertain = true;
    };
    transport.releaseAccountingSession = async () => {
      released = true;
    };
    transport.noteResponseStarted({ response: { id: "resp-1" } });
    transport.disconnect();
    await Promise.resolve();
    assert.equal(markedUncertain, true);
    assert.equal(released, false);
  });

  await test("a recorded response clears the abnormal-teardown guard", () => {
    const transport = testTransport();
    transport.noteResponseStarted({ response: { id: "resp-2" } });
    assert.equal(transport.hasUnaccountedResponse(), true);
    transport.noteResponseRecorded({ response: { id: "resp-2" } });
    assert.equal(transport.hasUnaccountedResponse(), false);
  });

  await test("clean teardown releases its exact accounting reservation", async () => {
    const transport = testTransport();
    let released = false;
    transport.accountingSessionId = "lease-1";
    transport.releaseAccountingSession = async () => {
      released = true;
    };
    transport.noteResponseStarted({ response: { id: "resp-3" } });
    transport.noteResponseRecorded({ response: { id: "resp-3" } });
    transport.disconnect();
    await Promise.resolve();
    assert.equal(released, true);
  });

  await test("a late mint after cancellation releases the returned lease", async () => {
    const transport = testTransport();
    let releasedId = "";
    transport.connectGeneration = 4;
    transport.closing = true;
    transport.accountingSessionId = "late-lease";
    transport.releaseAccountingSession = async (id) => {
      releasedId = id;
    };
    await assert.rejects(
      transport.assertConnectActive(4),
      /connect was cancelled/i,
    );
    assert.equal(releasedId, "late-lease");
  });

  await test("teardown aborts an in-flight SDP exchange", () => {
    const transport = testTransport();
    const controller = new AbortController();
    transport.connectAbort = controller;
    transport.disconnect();
    assert.equal(controller.signal.aborted, true);
  });

  await test("endSession quiesces before an injected response event can race release", async () => {
    const transport = testTransport();
    transport.accountingSessionId = "lease-close-race";
    let released = false;
    transport.releaseAccountingSession = async () => {
      released = true;
      transport.onEvent(JSON.stringify({ type: "response.created", response: { id: "late-response" } }));
    };
    transport.endSession("test close");
    await Promise.resolve();
    assert.equal(released, true);
    assert.equal(transport.hasUnaccountedResponse(), false);
  });

  await test("disconnect ignores queued provider events after close starts", async () => {
    const transport = testTransport();
    transport.accountingSessionId = "lease-disconnect-race";
    transport.releaseAccountingSession = async () => {
      queueMicrotask(() => {
        transport.onEvent(JSON.stringify({ type: "response.created", response: { id: "queued-response" } }));
      });
    };
    transport.disconnect();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(transport.hasUnaccountedResponse(), false);
  });

  await test("manual response creation authorizes and marks pending before send", async () => {
    const transport = testTransport();
    const sent = [];
    const invoked = [];
    transport.accountingSessionId = "lease-authorized";
    markSessionConfigurationAccepted(transport);
    transport.dc = { readyState: "open", send(body) { sent.push(JSON.parse(body)); } };
    transport.invokeCommand = async (command) => {
      invoked.push(command);
      if (command === "authorize_realtime_response") return 0.25;
      throw new Error(`unexpected ${command}`);
    };
    transport.onEvent(JSON.stringify({ type: "input_audio_buffer.committed" }));
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(invoked, ["authorize_realtime_response"]);
    assert.deepEqual(sent, [{ type: "response.create" }]);
    assert.equal(transport.hasUnaccountedResponse(), true);
  });

  await test("response.created without an ID retires its admission and fails closed", async () => {
    const transport = testTransport();
    let reason = "";
    let markedUncertain = false;
    transport.accountingSessionId = "lease-missing-response-id";
    transport.responseAdmissionGenerations = [transport.toolGeneration];
    transport.anonymousPendingResponses = 1;
    transport.markUsageUncertain = async () => { markedUncertain = true; };
    transport.onSessionEnd = (message) => { reason = message; };
    transport.onEvent(JSON.stringify({ type: "response.created", response: {} }));
    await Promise.resolve();
    assert.equal(transport.closing, true);
    assert.equal(markedUncertain, true);
    assert.match(reason, /unidentifiable response/i);
    assert.deepEqual(transport.responseAdmissionGenerations, []);
    assert.equal(transport.responseToolGenerations.size, 0);
  });

  await test("response.created with a whitespace-only ID cannot consume its FIFO admission", async () => {
    const transport = testTransport();
    let markedUncertain = false;
    transport.accountingSessionId = "lease-whitespace-response-id";
    transport.responseAdmissionGenerations = [777];
    transport.anonymousPendingResponses = 1;
    transport.markUsageUncertain = async () => { markedUncertain = true; };

    transport.onEvent(JSON.stringify({ type: "response.created", response: { id: "   " } }));
    await Promise.resolve();

    assert.equal(transport.closing, true);
    assert.equal(markedUncertain, true);
    assert.deepEqual(transport.responseAdmissionGenerations, []);
    assert.equal(transport.responseToolGenerations.size, 0);
    assert.equal(transport.responseToolGenerations.has("   "), false);
  });

  await test("only one response is admitted until prior usage is recorded", async () => {
    const transport = testTransport();
    const sent = [];
    let authorizations = 0;
    let records = 0;
    transport.accountingSessionId = "lease-serialized";
    markSessionConfigurationAccepted(transport);
    transport.dc = { readyState: "open", send(body) { sent.push(JSON.parse(body)); } };
    transport.invokeCommand = async (command) => {
      if (command === "authorize_realtime_response") {
        authorizations += 1;
        return 0.25;
      }
      if (command === "record_realtime_usage") {
        records += 1;
        return 0.30;
      }
      throw new Error(`unexpected ${command}`);
    };
    transport.onEvent(JSON.stringify({ type: "input_audio_buffer.committed" }));
    await Promise.resolve();
    await Promise.resolve();
    transport.onEvent(JSON.stringify({ type: "response.created", response: { id: "resp-first" } }));
    transport.onEvent(JSON.stringify({ type: "input_audio_buffer.committed" }));
    await Promise.resolve();
    assert.equal(authorizations, 1);
    assert.equal(sent.length, 1);
    await transport.handleResponseDone({
      type: "response.done",
      response: { id: "resp-first", usage: officialUsage() },
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(records, 1);
    assert.equal(authorizations, 2);
    assert.equal(sent.length, 2);
  });

  await test("a duplicate completed response ID cannot steal the next FIFO admission", async () => {
    const transport = testTransport();
    const sent = [];
    let records = 0;
    let uncertain = false;
    transport.accountingSessionId = "lease-duplicate-created";
    markSessionConfigurationAccepted(transport);
    transport.dc = {
      readyState: "open",
      send(body) { sent.push(JSON.parse(body)); },
      close() {},
    };
    transport.invokeCommand = async (command) => {
      if (command === "authorize_realtime_response") return 0.25;
      if (command === "record_realtime_usage") {
        records += 1;
        return 0.30;
      }
      throw new Error(`unexpected ${command}`);
    };
    transport.markUsageUncertain = async () => { uncertain = true; };

    transport.onEvent(JSON.stringify({ type: "input_audio_buffer.committed" }));
    await Promise.resolve();
    await Promise.resolve();
    transport.onEvent(JSON.stringify({ type: "response.created", response: { id: "resp-old" } }));
    assert.equal(transport.responseToolGenerations.has("resp-old"), true);

    // Match production response.done retirement before the asynchronous ledger write.
    transport.responseToolGenerations.delete("resp-old");
    await transport.handleResponseDone({
      type: "response.done",
      response: { id: "resp-old", usage: officialUsage() },
    });
    assert.equal(records, 1);

    transport.onEvent(JSON.stringify({ type: "input_audio_buffer.committed" }));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(transport.responseAdmissionGenerations.length, 1);
    assert.equal(sent.at(-1)?.type, "response.create");
    sent.length = 0;

    // A late duplicate for the completed response must fail closed without
    // consuming the newly authorized anonymous admission.
    transport.onEvent(JSON.stringify({ type: "response.created", response: { id: "resp-old" } }));
    await Promise.resolve();
    assert.equal(transport.closing, true);
    assert.equal(uncertain, true);
    assert.equal(transport.responseToolGenerations.has("resp-old"), false);

    await transport.handleToolCall({
      type: "response.function_call_arguments.done",
      response_id: "resp-old",
      name: "press_key",
      call_id: "call-duplicate-old",
      arguments: '{"key":"tab"}',
    });
    assert.equal(transport.pendingOwnerToken, null);
    assert.equal(sent.some((event) => event.type === "response.create"), false);
    assert.equal(sent.some((event) => event.type === "conversation.item.create"), false);
  });

  await test("duplicate response.done is recorded exactly once", async () => {
    const transport = testTransport();
    let records = 0;
    transport.accountingSessionId = "lease-idempotent";
    transport.invokeCommand = async (command) => {
      if (command === "record_realtime_usage") {
        records += 1;
        return 0.40;
      }
      throw new Error(`unexpected ${command}`);
    };
    transport.noteResponseStarted({ response: { id: "resp-once" } });
    const event = { type: "response.done", response: { id: "resp-once", usage: officialUsage() } };
    await transport.handleResponseDone(event);
    await transport.handleResponseDone(event);
    assert.equal(records, 1);
    assert.equal(transport.hasUnaccountedResponse(), false);
  });

  await test("recording failure keeps the response uncertain through teardown", async () => {
    const transport = testTransport();
    transport.accountingSessionId = "lease-record-failure";
    let unaccountedAtMark = false;
    transport.invokeCommand = async (command) => {
      if (command === "record_realtime_usage") throw new Error("ledger unavailable");
      throw new Error(`unexpected ${command}`);
    };
    transport.markUsageUncertain = async () => {
      unaccountedAtMark = transport.hasUnaccountedResponse();
    };
    transport.noteResponseStarted({ response: { id: "resp-record-failure" } });
    await transport.handleResponseDone({
      type: "response.done",
      response: { id: "resp-record-failure", usage: officialUsage() },
    });
    await Promise.resolve();
    assert.equal(unaccountedAtMark, true);
    assert.equal(transport.closing, true);
  });

  await test("clean cap cutoff releases the exact lease without uncertain usage", async () => {
    const transport = testTransport();
    const released = [];
    let markedUncertain = false;
    transport.accountingSessionId = "lease-clean-cap";
    transport.invokeCommand = async (command, args) => {
      assert.equal(command, "record_realtime_usage");
      assert.equal(args.accountingSessionId, "lease-clean-cap");
      return 4.5;
    };
    transport.markUsageUncertain = async () => {
      markedUncertain = true;
    };
    transport.releaseAccountingSession = async (accountingSessionId) => {
      released.push(accountingSessionId);
    };
    transport.noteResponseStarted({ response: { id: "resp-clean-cap" } });
    await transport.handleResponseDone({
      type: "response.done",
      response: { id: "resp-clean-cap", usage: officialUsage() },
    });
    await Promise.resolve();
    assert.deepEqual(released, ["lease-clean-cap"]);
    assert.equal(markedUncertain, false);
    assert.equal(transport.hasUnaccountedResponse(), false);
    assert.equal(transport.closing, true);
  });

  await test("abnormal connection close retains the lease as uncertain", async () => {
    const transport = testTransport();
    transport.accountingSessionId = "lease-abnormal";
    let marked = false;
    let released = false;
    transport.markUsageUncertain = async () => { marked = true; };
    transport.releaseAccountingSession = async () => { released = true; };
    transport.endSession("connection dropped", true);
    await Promise.resolve();
    assert.equal(marked, true);
    assert.equal(released, false);
  });

  await test("closing transport blocks every later send", () => {
    const transport = testTransport();
    let sends = 0;
    transport.dc = { readyState: "open", send() { sends += 1; } };
    transport.closing = true;
    assert.equal(transport.send({ type: "response.create" }), false);
    assert.equal(sends, 0);
  });

  await test("Realtime speech-start barge-in requests a scoped backend stop", () => {
    const transport = testTransport();
    const stopped = [];
    transport.pendingOwnerToken = "realtime:old-turn";
    transport.queueOwnedOperatorStop = async (ownerToken) => {
      stopped.push(ownerToken);
    };
    transport.onEvent(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    assert.deepEqual(stopped, ["realtime:old-turn"]);
    assert.equal(transport.toolAbort, null);
  });

  for (const [label, name, args] of [
    ["unknown", "unknown_late_tool", {}],
    ["known", "press_key", { key: "tab" }],
  ]) {
    await test(`speech-start rejects a late ${label} tool without another paid response`, async () => {
      const transport = testTransport();
      const sent = [];
      let nextResponses = 0;
      transport.dc = { readyState: "open", send(payload) { sent.push(JSON.parse(payload)); } };
      const responseId = await admitToolResponse(transport, `resp-late-${label}`);
      sent.length = 0;
      transport.queueResponseCreate = () => { nextResponses += 1; };

      transport.onEvent(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
      await transport.handleToolCall({
        type: "response.function_call_arguments.done",
        response_id: responseId,
        name,
        call_id: `call-late-${label}`,
        arguments: JSON.stringify(args),
      });

      assert.equal(transport.pendingOwnerToken, null);
      assert.equal(nextResponses, 0);
      assert.deepEqual(sent, [{
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: `call-late-${label}`, output: "Stopped." },
      }]);
    });
  }

  await test("manual interruption and teardown reject every later tool event", async () => {
    for (const action of ["manual", "teardown"]) {
      const transport = testTransport();
      const sent = [];
      let nextResponses = 0;
      transport.dc = {
        readyState: "open",
        send(payload) { sent.push(JSON.parse(payload)); },
        close() {},
      };
      const responseId = await admitToolResponse(transport, `resp-${action}`);
      sent.length = 0;
      transport.queueResponseCreate = () => { nextResponses += 1; };
      if (action === "manual") transport.stopSpeaking();
      else transport.disconnect();
      await transport.handleToolCall({
        type: "response.function_call_arguments.done",
        response_id: responseId,
        name: "press_key",
        call_id: `call-${action}`,
        arguments: '{"key":"tab"}',
      });
      assert.equal(nextResponses, 0);
      if (action === "manual") {
        assert.equal(sent.at(-1)?.item?.output, "Stopped.");
      } else {
        assert.equal(sent.length, 0);
      }
    }
  });

  await test("replacement Realtime tool waits for the interrupted owner stop", async () => {
    const transport = testTransport();
    let releaseStop;
    const stopGate = new Promise((resolve) => { releaseStop = resolve; });
    const stopped = [];
    const sent = [];
    const oldController = new AbortController();
    transport.pendingOwnerToken = "realtime:old-tool";
    transport.toolAbort = oldController;
    const responseId = armToolResponse(transport, "resp-replacement");
    transport.queueOwnedOperatorStop = async (ownerToken) => {
      stopped.push(ownerToken);
      await stopGate;
    };
    transport.dc = { readyState: "open", send(payload) { sent.push(JSON.parse(payload)); } };

    const replacement = transport.handleToolCall({
      type: "response.function_call_arguments.done",
      response_id: responseId,
      name: "unknown_test_tool",
      call_id: "call-replacement",
      arguments: "{}",
    });
    await Promise.resolve();
    assert.equal(oldController.signal.aborted, true);
    assert.deepEqual(stopped, ["realtime:old-tool"]);
    assert.equal(sent.length, 0);

    releaseStop();
    await replacement;
    assert.equal(sent[0]?.type, "conversation.item.create");
    assert.equal(sent[0]?.item?.call_id, "call-replacement");
  });

  await test("rejected scoped stop emits Stopped and never buys a follow-up response", async () => {
    const transport = testTransport();
    const sent = [];
    let nextResponses = 0;
    const oldController = new AbortController();
    transport.pendingOwnerToken = "realtime:uncertain-owner";
    transport.toolAbort = oldController;
    const responseId = armToolResponse(transport, "resp-stop-rejected");
    transport.queueOwnedOperatorStop = async () => {
      throw new Error("abort IPC unavailable");
    };
    transport.queueResponseCreate = () => { nextResponses += 1; };
    transport.dc = { readyState: "open", send(payload) { sent.push(JSON.parse(payload)); } };

    await transport.handleToolCall({
      type: "response.function_call_arguments.done",
      response_id: responseId,
      name: "press_key",
      call_id: "call-stop-rejected",
      arguments: '{"key":"tab"}',
    });

    assert.equal(oldController.signal.aborted, true);
    assert.equal(nextResponses, 0);
    assert.equal(transport.pendingOwnerToken, "realtime:uncertain-owner");
    assert.equal(sent.at(-1)?.item?.output, "Stopped.");
  });

  await test("replacement waits for the old awaited actuator even after stop acknowledgement", async () => {
    const transport = testTransport();
    let releaseOldActuator;
    const oldActuatorTerminal = new Promise((resolve) => { releaseOldActuator = resolve; });
    const sent = [];
    let stopAcknowledged = false;
    transport.activeToolTerminal = oldActuatorTerminal;
    transport.queueOwnedOperatorStop = async () => { stopAcknowledged = true; };
    transport.queueResponseCreate = () => {};
    transport.dc = { readyState: "open", send(payload) { sent.push(JSON.parse(payload)); } };
    const responseId = armToolResponse(transport, "resp-old-actuator");

    const replacement = transport.handleToolCall({
      type: "response.function_call_arguments.done",
      response_id: responseId,
      name: "unknown_test_tool",
      call_id: "call-old-actuator",
      arguments: "{}",
    });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(stopAcknowledged, true);
    assert.equal(sent.length, 0);

    releaseOldActuator();
    await replacement;
    assert.equal(sent.at(-1)?.item?.call_id, "call-old-actuator");
  });

  await test("late async completion cannot re-arm the idle timer after teardown", () => {
    const transport = new RealtimeTransport();
    transport.idleTimer = setTimeout(() => {
      throw new Error("closed transport retained an idle timer");
    }, 1_000);
    transport.closing = true;
    transport.resetIdleTimer();
    assert.equal(transport.idleTimer, null);
  });

  await test("unmetered completion wakes exactly one queued tool continuation", async () => {
    const transport = testTransport();
    const sent = [];
    transport.dc = { readyState: "open", send(payload) { sent.push(JSON.parse(payload)); } };
    const responseId = await admitToolResponse(transport, "resp-unmetered-continuation");
    sent.length = 0;
    let admissions = 0;
    transport.invokeCommand = async (command) => {
      assert.equal(command, "authorize_realtime_response");
      admissions += 1;
      return 0.25;
    };
    transport.queueResponseCreate(transport.toolGeneration);
    assert.equal(admissions, 0, "continuation waits for pending response completion");
    const done = { type: "response.done", response: { id: responseId, usage: null } };
    await transport.handleResponseDone(done);
    await Promise.resolve();
    await transport.handleResponseDone(done);
    assert.equal(admissions, 1);
    assert.equal(sent.filter(event => event.type === "response.create").length, 1);
  });

  await test("parallel startup stops a late microphone after mint failure", async () => {
    const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    let resolveMic;
    let rejectMint;
    let stopped = 0;
    let micRequested = false;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {} } });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
      mediaDevices: { getUserMedia() {
        micRequested = true;
        return new Promise(resolve => { resolveMic = resolve; });
      } },
    } });
    try {
      const transport = testTransport();
      transport.invokeCommand = () => new Promise((_, reject) => { rejectMint = reject; });
      const connecting = transport.connect();
      assert.equal(micRequested, true, "device startup overlaps unresolved mint");
      rejectMint(new Error("mint unavailable"));
      await assert.rejects(connecting, /mint unavailable/);
      resolveMic({ getTracks: () => [{ stop() { stopped++; } }] });
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(stopped, 1, "late microphone does not remain live after startup failed");
    } finally {
      if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else delete globalThis.window;
      if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator); else delete globalThis.navigator;
    }
  });

  // ── Ctrl+T and CONVERSE are one session (2026-09-15) ───────────────────────
  console.log("\nsingle Ctrl+T turn on the Realtime session");
  const {
    OPENAI_CREDIT_EXHAUSTED,
    describeSdpFailure,
    isCreditExhausted,
    noteCreditRefused,
    creditRefusalActive,
    CREDIT_RECHECK_MS,
  } = mod.exports;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  const liveTransport = (lease) => {
    const transport = testTransport();
    const sent = [];
    transport.dc = { readyState: "open", send(payload) { sent.push(JSON.parse(payload)); } };
    transport.connected = true;
    transport.accountingSessionId = lease;
    markSessionConfigurationAccepted(transport);
    return { transport, sent };
  };

  await test("an empty-wallet SDP 429 becomes the plain credit sentence", () => {
    // The body OpenAI returned to the owner's 12:02 test, trimmed to the fields that matter.
    const body = JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota" } });
    assert.equal(describeSdpFailure(429, body), OPENAI_CREDIT_EXHAUSTED);
    assert.match(OPENAI_CREDIT_EXHAUSTED, /credit is used up - add credit/);
    assert.match(describeSdpFailure(429, '{"error":{"code":"rate_limit_exceeded"}}'), /rate-limiting/);
    assert.equal(describeSdpFailure(500, ""), "Realtime SDP exchange failed (HTTP 500).");
  });

  await test("both wallet refusals are recognised, and nothing else is", () => {
    assert.ok(isCreditExhausted(new Error(OPENAI_CREDIT_EXHAUSTED)));
    // The Rust mint's own sentence (openai_realtime.rs).
    assert.ok(isCreditExhausted("OpenAI API credit is used up - add credit at platform.openai.com (Billing), then press the chord again."));
    assert.ok(isCreditExhausted('{"code":"insufficient_quota"}'));
    assert.ok(!isCreditExhausted(new Error("realtime connect timed out")));
    assert.ok(!isCreditExhausted("OpenAI returned HTTP 500 minting a realtime session."));
  });

  await test("a credit refusal is a five-minute TTL, not a latch", () => {
    const now = 1_789_490_000_000;
    noteCreditRefused(now);
    assert.equal(creditRefusalActive(now + 60_000), true);
    assert.equal(creditRefusalActive(now + CREDIT_RECHECK_MS + 1), false);
  });

  await test("a single turn's words enter the session as ONE user text item and ONE admitted response", async () => {
    const { transport, sent } = liveTransport("lease-once");
    let admissions = 0;
    transport.invokeCommand = async (command) => {
      assert.equal(command, "authorize_realtime_response");
      admissions += 1;
      return 0.1;
    };
    assert.equal(transport.sendUserText("go to Google Chrome and open Gmail"), true);
    await flush();
    const items = sent.filter((event) => event.type === "conversation.item.create");
    assert.deepEqual(items.map((event) => event.item), [
      { type: "message", role: "user", content: [{ type: "input_text", text: "go to Google Chrome and open Gmail" }] },
    ]);
    assert.equal(admissions, 1, "the spend gate admits the text turn exactly like a spoken one");
    assert.equal(sent.filter((event) => event.type === "response.create").length, 1);
    transport.resetTurnTracking();
  });

  await test("no accepted session, no text turn", () => {
    const transport = testTransport();
    assert.equal(transport.sendUserText("hello"), false, "not connected");
    transport.connected = true;
    assert.equal(transport.sendUserText("hello"), false, "configuration not accepted yet");
  });

  await test("a turn is over only once its response is recorded AND its audio has drained", async () => {
    const { transport } = liveTransport("lease-idle");
    transport.invokeCommand = async (command) =>
      command === "authorize_realtime_response" ? 0.1 : command === "record_realtime_usage" ? 0.2 : undefined;
    const idle = [];
    transport.onTurnIdle = (text) => idle.push(text);
    assert.equal(transport.sendUserText("what's on my calendar"), true);
    await flush();
    transport.onEvent(JSON.stringify({ type: "response.created", response: { id: "resp-once" } }));
    transport.onEvent(JSON.stringify({ type: "output_audio_buffer.started", response_id: "resp-once" }));
    transport.onEvent(JSON.stringify({
      type: "response.output_audio_transcript.done",
      response_id: "resp-once",
      transcript: "You have nothing until three.",
    }));
    transport.onEvent(JSON.stringify({ type: "response.done", response: { id: "resp-once", usage: officialUsage() } }));
    await flush();
    await sleep(500);
    assert.equal(idle.length, 0, "still audible: the output buffer has not drained");
    transport.onEvent(JSON.stringify({ type: "output_audio_buffer.stopped", response_id: "resp-once" }));
    await sleep(500);
    assert.deepEqual(idle, ["You have nothing until three."], "the last spoken line comes with it");
    await sleep(450);
    assert.equal(idle.length, 1, "once per turn");
  });

  await test("a running tool holds the turn open", async () => {
    const { transport } = liveTransport("lease-tool");
    const idle = [];
    transport.onTurnIdle = (text) => idle.push(text);
    transport.turnPending = true;
    transport.sawOutputAudioBuffer = true;
    transport.activeToolTerminal = new Promise(() => {});
    transport.scheduleTurnIdleCheck();
    await sleep(450);
    assert.equal(idle.length, 0, "Atlas is still clicking through Chrome");
    transport.activeToolTerminal = null;
    transport.scheduleTurnIdleCheck();
    await sleep(450);
    assert.equal(idle.length, 1);
  });

  await test("setInputEnabled mutes and unmutes the microphone toward OpenAI", () => {
    const transport = testTransport();
    const track = { enabled: true };
    transport.micStream = { getAudioTracks: () => [track], getTracks: () => [track] };
    transport.setInputEnabled(false);
    assert.equal(track.enabled, false, "a single turn records locally; OpenAI hears nothing");
    transport.setInputEnabled(true);
    assert.equal(track.enabled, true, "upgraded to a conversation on the same session");
  });

  console.log(`\nPASS — ${passed} passed, 0 failed`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
