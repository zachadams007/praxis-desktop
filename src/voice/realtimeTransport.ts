/**
 * realtimeTransport - OpenAI GPT-Realtime-2 speech-to-speech over WebRTC.
 *
 * The second implementation of HybridTransport, and the stack Example Creator's voice assistant
 * runs on: the model hears you and speaks back natively (no separate STT/TTS),
 * server-side VAD gives natural turn-taking, and a new utterance interrupts the
 * model mid-sentence (native barge-in). `ownsInput = true`, so useHybridSession
 * defers its own capture loop to this transport entirely - the router and UI are
 * untouched.
 *
 * Connection recipe (verified live against OpenAI's docs 2026-07-02):
 *   1. Rust `mint_realtime_session` reads OPENAI_API_KEY from the vault and mints an
 *      EPHEMERAL client secret (ek_…) for a gpt-realtime-2 session. The raw key
 *      never reaches this webview.
 *   2. new RTCPeerConnection(); add the mic track (getUserMedia audio).
 *   3. pc.ontrack → play the remote audio stream (that IS the voice - s2s).
 *   4. Open data channel "oai-events" for session + tool-call events.
 *   5. POST the SDP offer to https://api.openai.com/v1/realtime/calls with the
 *      ephemeral token as Bearer and Content-Type: application/sdp; apply the
 *      returned SDP answer.
 *   6. On datachannel open, send ONE session.update: stable system prompt (prompt
 *      caching), the shared hybrid tool roster, cedar voice, and server_vad turn
 *      detection with interrupt_response so barge-in is native.
 *   7. Tool bridge: a response.function_call_arguments.done event → dispatch the
 *      call through the SAME router the local stack uses (hybridTools.dispatchToolCall)
 *      → send the result back as a function_call_output + response.create so the
 *      model speaks the outcome.
 *   8. Cost: every response.done carries a usage object; hand its token breakdown to
 *      Rust record_realtime_usage, which prices it and writes the shared ledger. If
 *      the returned cumulative spend crosses the cap, end the session (the next
 *      connect falls back to the local stack).
 *   9. Idle: after ~2 min with no speech, disconnect to stop the meter; the next
 *      chord press reconnects.
 */

import type { HybridTransport } from "./hybridTransport";
import { HYBRID_TOOL_SPECS, dispatchToolCall } from "./hybridTools";
import {
  createOperatorOwnerToken,
  createOperatorTurnEpoch,
  getUnresolvedOperatorOwners,
  SerializedOperatorStopQueue,
  stopOperatorOwners,
  stopOperatorSessionRuns,
  waitForCurrentOperatorTurn,
} from "./stopOperatorRuns";
import { REALTIME_SYSTEM_PROMPT } from "./realtimePrompt";
import { mirrorRealtimeTurn, resetRealtimeMirror } from "./atlasChatBridge";

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: inv } = await import("@tauri-apps/api/core");
  return inv<T>(cmd, args ?? {});
}

/** Praxis's context card for a new session (atlas_context.rs); "" if it can't be had in 4 s. */
function fetchContextCard(): Promise<string> {
  return Promise.race([
    invoke<string>("atlas_context_card").catch(() => ""),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), 4000)),
  ]);
}

// ── Availability (asks Rust; never sees the key) ─────────────────────────────

interface RealtimeReady {
  ready: boolean;
  has_key: boolean;
  spent_usd: number;
  cap_usd: number;
  reason: string;
}

/**
 * Cached availability, refreshed by `refreshRealtimeReady()`. createHybridTransport()
 * is synchronous, so it reads this cache; the session hook refreshes it (an async
 * Rust call) before deciding which transport to build. Defaults to NOT ready so the
 * local stack is the safe default until Rust confirms the key + budget.
 */
let readyCache: RealtimeReady = {
  ready: false,
  has_key: false,
  spent_usd: 0,
  cap_usd: 4.5,
  reason: "",
};
let realtimeUsageUncertainLatch = false;

// ── An empty OpenAI wallet, said in words ────────────────────────────────────
//
// The account had no credit: `client_secrets` still minted (200) and the SDP POST was the call
// that refused. The Rust mint already translated its own 429; this one was shown to him as a
// status code.

/** The one sentence for an empty wallet, wherever OpenAI refuses it. */
export const OPENAI_CREDIT_EXHAUSTED =
  "OpenAI API credit is used up - add credit at platform.openai.com (Billing).";

/** True for either wallet refusal: the Rust mint's sentence or the SDP 429 body. */
export function isCreditExhausted(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /credit is used up|insufficient_quota|credit_balance/i.test(text);
}

/** A failed SDP exchange as a sentence. The 429 body is the wallet signal. */
export function describeSdpFailure(status: number, body: string): string {
  if (status === 429 && /insufficient_quota|credit_balance|billing/i.test(body)) return OPENAI_CREDIT_EXHAUSTED;
  if (status === 429) return "OpenAI is rate-limiting Realtime right now (HTTP 429).";
  return `Realtime SDP exchange failed (HTTP ${status}).`;
}

/**
 * When OpenAI last refused Realtime for an empty wallet.
 *
 * A TTL, not a latch: every Ctrl+T used to pay a full mint + SDP round trip only to
 * be refused again, so for five minutes the session goes straight to the local lane
 * and says why. After that the next press asks OpenAI again, and any successful
 * connect clears it at once.
 */
let creditRefusedAt = 0;
export const CREDIT_RECHECK_MS = 5 * 60 * 1000;

export function noteCreditRefused(now = Date.now()): void {
  creditRefusedAt = now;
  // Also persist it. This TTL is per-webview and dies on reload, so on its own it
  // could never tell the Command Center why voice had gone quiet - the OpenAI rail
  // went on drawing a spend bar through the whole refused stretch on 2026-09-15.
  // Rust owns the durable copy; failing to write it must never break the voice path.
  void invoke("note_openai_credit_refusal", { source: "realtime sdp" }).catch(() => {});
}

/** A connect that worked. Retires the refusal in both layers - success is proof. */
export function noteCreditAccepted(): void {
  creditRefusedAt = 0;
  void invoke("clear_openai_credit_refusal").catch(() => {});
}

export function creditRefusalActive(now = Date.now()): boolean {
  return creditRefusedAt > 0 && now - creditRefusedAt < CREDIT_RECHECK_MS;
}

/** Synchronous availability read (used by createHybridTransport's branch). */
export function realtimeAvailable(): boolean {
  return readyCache.ready;
}

/** The last-known availability detail (for the session panel's transport tag). */
export function realtimeStatus(): RealtimeReady {
  return readyCache;
}

/**
 * Call before createHybridTransport() so the branch is accurate. Guarded: in a dev browser (no
 * Tauri) it stays not-ready.
 */
export async function refreshRealtimeReady(): Promise<RealtimeReady> {
  if (realtimeUsageUncertainLatch) {
    readyCache = {
      ...readyCache,
      ready: false,
      reason: "OpenAI realtime usage is uncertain; using the local voice to protect the spend cap.",
    };
    return readyCache;
  }
  if (!inTauri()) {
    readyCache = { ...readyCache, ready: false, has_key: false, reason: "Realtime needs the Praxis desktop app." };
    return readyCache;
  }
  try {
    const refreshed = await invoke<RealtimeReady>("realtime_ready");
    readyCache = realtimeUsageUncertainLatch
      ? {
          ...refreshed,
          ready: false,
          reason: "OpenAI realtime usage is uncertain; using the local voice to protect the spend cap.",
        }
      : refreshed.ready && creditRefusalActive()
        ? { ...refreshed, ready: false, reason: OPENAI_CREDIT_EXHAUSTED }
        : refreshed;
  } catch (err) {
    readyCache = { ...readyCache, ready: false, reason: `Realtime check failed: ${String(err).slice(0, 80)}` };
  }
  return readyCache;
}

// ── The mint contract (from Rust) ────────────────────────────────────────────

interface MintedSession {
  client_secret: string;
  expires_at: number;
  model: string;
  voice: string;
  calls_url: string;
  accounting_session_id: string;
  max_output_tokens: number;
  post_instruction_tokens: number;
  reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh";
}

// ── Usage breakdown (mirrors Rust RealtimeUsage; snake_case for the invoke) ──

interface RealtimeUsagePayload {
  audio_input_tokens: number;
  cached_audio_input_tokens: number;
  text_input_tokens: number;
  cached_text_input_tokens: number;
  image_input_tokens: number;
  audio_output_tokens: number;
  text_output_tokens: number;
}

/** Pull the token breakdown out of a response.done `usage` object (defensively). */
export function extractUsage(usage: unknown): RealtimeUsagePayload | null {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>;
  const details = (value: unknown): Record<string, unknown> | null => {
    if (value === undefined) return {};
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  };
  const inDet = details(u.input_token_details);
  const outDet = details(u.output_token_details);
  if (!inDet || !outDet) return null;
  const token = (v: unknown): number | null => {
    if (v === undefined) return 0;
    return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  };
  const audioInput = token(inDet.audio_tokens);
  let textInput = token(inDet.text_tokens);
  const imageInput = token(inDet.image_tokens);
  let cachedTotal = token(inDet.cached_tokens);
  const audioOutput = token(outDet.audio_tokens);
  let textOutput = token(outDet.text_tokens);
  if (
    audioInput === null || textInput === null || imageInput === null ||
    cachedTotal === null || audioOutput === null || textOutput === null
  ) return null;

  let cachedAudio = 0;
  let cachedText = 0;
  let cachedImage = 0;
  if (inDet.cached_tokens_details !== undefined) {
    const cachedDetails = details(inDet.cached_tokens_details);
    if (!cachedDetails) return null;
    const parsedAudio = token(cachedDetails.audio_tokens);
    const parsedText = token(cachedDetails.text_tokens);
    const parsedImage = token(cachedDetails.image_tokens);
    if (parsedAudio === null || parsedText === null || parsedImage === null) return null;
    if (inDet.cached_tokens === undefined) {
      cachedTotal = parsedAudio + parsedText + parsedImage;
    }
    cachedAudio = parsedAudio;
    cachedText = parsedText;
    cachedImage = parsedImage;
    if (cachedAudio + cachedText + parsedImage !== cachedTotal) return null;
  }

  const totalInput = token(u.input_tokens);
  const totalOutput = token(u.output_tokens);
  if (totalInput === null || totalOutput === null) return null;
  const detailedInput = audioInput + textInput + imageInput;
  const detailedOutput = audioOutput + textOutput;
  if (u.input_tokens !== undefined) {
    if (totalInput < detailedInput) return null;
    textInput += totalInput - detailedInput;
  }
  if (u.output_tokens !== undefined) {
    if (totalOutput < detailedOutput) return null;
    // gpt-realtime-2 may report reasoning tokens only in the aggregate. They use
    // the text-output rate, which is also the conservative classification.
    textOutput += totalOutput - detailedOutput;
  }
  const pricedInput = u.input_tokens === undefined
    ? audioInput + textInput + imageInput
    : totalInput;
  if (
    cachedTotal > pricedInput ||
    cachedAudio > audioInput ||
    cachedText > textInput ||
    cachedImage > imageInput
  ) return null;
  // Aggregate cache totals without modality details are intentionally ignored:
  // pricing every token at the non-cached rate is a safe upper bound.
  const payload: RealtimeUsagePayload = {
    audio_input_tokens: audioInput,
    cached_audio_input_tokens: cachedAudio,
    text_input_tokens: textInput,
    cached_text_input_tokens: cachedText,
    image_input_tokens: imageInput,
    audio_output_tokens: audioOutput,
    text_output_tokens: textOutput,
  };
  return payload;
}

function usageJsonSnippet(usage: unknown): string {
  try {
    return (JSON.stringify(usage) ?? String(usage)).slice(0, 600);
  } catch {
    return "\"<unserializable>\"";
  }
}

// ── Idle auto-disconnect ─────────────────────────────────────────────────────

// Ten quiet minutes, not two: two minutes ended real conversations mid-task, and the end
// used to hand the session to the local lane in a different voice.
const IDLE_DISCONNECT_MS = 10 * 60 * 1000;
const SESSION_CONFIGURATION_TIMEOUT_MS = 10_000;

interface PendingSessionConfiguration {
  eventId: string;
  connectGeneration: number;
  expected: {
    model: string;
    maxOutputTokens: number;
    reasoningEffort: MintedSession["reasoning_effort"];
    voice: string;
    toolNames: string[];
  };
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
}

// ── The transport ────────────────────────────────────────────────────────────

/**
 * How long a `disconnected` ICE state may last before the session is really ended.
 * Long enough to ride out a Wi-Fi roam or a brief packet-loss burst, short enough
 * that a genuinely dead link does not leave Atlas looking alive.
 */
const DROP_GRACE_MS = 6000;

/** How long after the model's audio drains before a turn counts as finished. */
const TURN_IDLE_GRACE_MS = 350;
/** The same, when this session never reported `output_audio_buffer.*` and the
 *  drain has to be inferred from the end of generation. */
const TURN_IDLE_INFERRED_GRACE_MS = 1200;

export interface RealtimeConnectOptions {
  /**
   * A microphone track the caller already opened, CLONED from its own stream. The
   * transport owns the clone and stops it on teardown. Omit to open the mic here.
   */
  inputTrack?: MediaStreamTrack;
  /**
   * Whether OpenAI hears the microphone. A single Ctrl+T turn records locally and
   * sends its words as text, so it connects muted; `setInputEnabled(true)` turns the
   * same session into a spoken conversation. Defaults to true.
   */
  inputEnabled?: boolean;
}

export class RealtimeTransport implements HybridTransport {
  readonly ownsInput = true;
  private invokeCommand = invoke;
  private timingStarted = performance.now();

  /** Stage timings contain no audio, transcript, arguments, or credentials. */
  private timing(stage: string): void {
    const sample = { stage, elapsedMs: Math.round(performance.now() - this.timingStarted) };
    console.info("[realtime:timing]", sample);
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent !== "undefined") {
      window.dispatchEvent(new CustomEvent("praxis:voice-timing", { detail: sample }));
    }
  }

  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private micStream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private speaking = false;
  private speakingListeners = new Set<(v: boolean) => void>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private closing = false;
  /** Pending teardown for a `disconnected` link that may still heal. */
  private dropGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private toolAbort: AbortController | null = null;
  private pendingOwnerToken: string | null = null;
  private detachedOwnerTokens = new Set<string>();
  private operatorStopQueue = new SerializedOperatorStopQueue();
  private toolTurnEpoch = createOperatorTurnEpoch();
  private activeToolTerminal: Promise<void> | null = null;
  /** Monotonic user-turn generation. Response IDs are bound to the generation
   *  that authorized their response.create so late provider events cannot become
   *  current merely because they arrived after a barge-in. */
  private toolGeneration = 0;
  private responseToolGenerations = new Map<string, number>();
  private responseAdmissionGenerations: number[] = [];
  private seenResponseIds = new Set<string>();
  private pendingResponseIds = new Set<string>();
  private recordingResponseIds = new Set<string>();
  private recordedResponseIds = new Set<string>();
  private anonymousPendingResponses = 0;
  private queuedResponseCreate = false;
  private queuedResponseGeneration: number | null = null;
  private responseCreatePending = false;
  private usageUncertain = false;
  /**
   * Turns whose usage block OpenAI sent in a shape `extractUsage` could not read.
   * The conversation continues; this session's spend estimate is a floor rather
   * than a total, and that is said out loud in the console rather than silently
   * absorbed or escalated into a feature-wide latch.
   */
  private unmeteredTurns = 0;
  private unreadableUsageWarned = false;
  private accountingSessionId = "";
  private connectGeneration = 0;
  private connectAbort: AbortController | null = null;
  private pendingSessionConfiguration: PendingSessionConfiguration | null = null;
  private sessionConfigurationAcceptedGeneration: number | null = null;
  private sessionConfigurationTimeoutMs = SESSION_CONFIGURATION_TIMEOUT_MS;
  /** Called when the session ends itself so the hook can react. `kind` is "idle" for a
   *  quiet-stretch pause (the hook ENDS the session - it must never hand the
   *  conversation to a different engine just because nobody spoke), "failure" for
   *  everything else. Set by the hook. */
  onSessionEnd: ((reason: string, kind: "idle" | "failure") => void) | null = null;
  /** Called with a feed item for each resolved tool call, so the panel can render it. */
  onFeedItem: ((item: import("./hybridRouter").HybridFeedItem) => void) | null = null;
  /**
   * Called once a user turn has fully played out: every response recorded, no tool
   * running or queued, and the model's audio drained. Receives the last thing Atlas
   * said, so a single-turn session can keep listening when that was a question.
   */
  onTurnIdle: ((lastAssistantText: string) => void) | null = null;

  // ── Turn completion ────────────────────────────────────────────────────────
  /** A user turn (typed text or committed audio) that has not played out yet. */
  private turnPending = false;
  /** WebRTC `output_audio_buffer.started` .. `stopped`: the model is audible. */
  private outputAudioActive = false;
  /** Whether this session has ever seen an output_audio_buffer event. Without them
   *  the drain is inferred from `response.output_audio.done` plus a longer grace. */
  private sawOutputAudioBuffer = false;
  private turnIdleTimer: ReturnType<typeof setTimeout> | null = null;
  /** A continuation waiting out OpenAI's tokens-per-minute limit (see handleResponseDone). */
  private rateLimitRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private rateLimitRetries = 0;
  private lastAssistantText = "";

  // ── HybridTransport surface ────────────────────────────────────────────────

  /**
   * With a speech-to-speech transport, `say` is a no-op for router-driven text:
   * the MODEL produces speech from audio directly. The router only calls say() for
   * its own confirmations, which we don't want to double-voice over the model. We
   * keep the signature (interface contract) and resolve immediately.
   */
  say(_text: string): Promise<void> {
    return Promise.resolve();
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  /** Serialize scoped backend stops so a replacement tool cannot race an older
   *  Computer Use/Sovereign run for the single native operator slot. */
  private queueOwnedOperatorStop(ownerToken: string | null): Promise<void> {
    return this.operatorStopQueue.enqueue(ownerToken);
  }

  /** Retire every tool event belonging to the prior user/response turn. */
  private invalidateToolTurn(): void {
    this.toolGeneration += 1;
    this.toolTurnEpoch.invalidate();
    this.queuedResponseCreate = false;
    this.queuedResponseGeneration = null;
  }

  /** Bind a server response ID to the generation of the response.create that
   *  admitted it. With manual response creation there is exactly one authorized
   *  response at a time, so this FIFO is deterministic and fail-closed. */
  private bindResponseToolGeneration(evt: Record<string, unknown>): boolean {
    const responseId = this.responseId(evt);
    if (
      !responseId ||
      this.seenResponseIds.has(responseId) ||
      this.responseToolGenerations.has(responseId) ||
      this.pendingResponseIds.has(responseId) ||
      this.recordingResponseIds.has(responseId) ||
      this.recordedResponseIds.has(responseId)
    ) return false;
    const generation = this.responseAdmissionGenerations.shift();
    if (generation === undefined) return false;
    this.seenResponseIds.add(responseId);
    this.responseToolGenerations.set(responseId, generation);
    return true;
  }

  private toolEventGeneration(evt: Record<string, unknown>): number | null {
    const responseId = this.responseId(evt);
    if (!responseId) return null;
    return this.responseToolGenerations.get(responseId) ?? null;
  }

  /** Barge-in. Server VAD already interrupts on new speech; this also lets the UI's
   *  tap-to-interrupt cut the model. WebRTC requires response.cancel followed by
   *  output_audio_buffer.clear. We deliberately do not pause the media element:
   *  pausing it can permanently silence every later response. */
  stopSpeaking(): void {
    const interruptedOwner = this.pendingOwnerToken;
    this.invalidateToolTurn();
    this.toolAbort?.abort();
    if (interruptedOwner) {
      void this.queueOwnedOperatorStop(interruptedOwner).catch(() => {
        // Retained by the queue; the next tool admission retries and stays closed.
      });
    }
    if (this.speaking || this.hasUnaccountedResponse()) {
      this.send({ type: "response.cancel" });
      this.send({ type: "output_audio_buffer.clear" });
    }
    this.setSpeaking(false);
  }

  onSpeakingChange(fn: (speaking: boolean) => void): () => void {
    this.speakingListeners.add(fn);
    return () => this.speakingListeners.delete(fn);
  }

  /** True once the session configuration was accepted and until teardown. */
  isConnected(): boolean {
    return this.connected && !this.closing;
  }

  /** Let OpenAI hear the microphone, or mute it toward OpenAI. */
  setInputEnabled(on: boolean): void {
    for (const track of this.micStream?.getAudioTracks() ?? []) track.enabled = on;
    if (on) this.resetIdleTimer();
  }

  /**
   * Take ONE user turn as text: the words a single Ctrl+T captured and transcribed
   * locally. Same session, same instructions, same tools and the same voice as a
   * spoken conversation; only the input arrived as text. A new turn retires the
   * previous one exactly like speech starting would. Returns false when there is no
   * accepted session to take it.
   */
  sendUserText(text: string): boolean {
    const body = text.trim();
    if (!body || !this.isConnected() || this.sessionConfigurationAcceptedGeneration !== this.connectGeneration) {
      return false;
    }
    this.invalidateToolTurn();
    if (this.pendingOwnerToken) {
      void this.queueOwnedOperatorStop(this.pendingOwnerToken).catch(() => {
        // Retained by the queue; a replacement cannot admit on uncertainty.
      });
    }
    this.toolAbort?.abort();
    if (this.speaking || this.hasUnaccountedResponse()) {
      this.send({ type: "response.cancel" });
      this.send({ type: "output_audio_buffer.clear" });
    }
    const sent = this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: body }] },
    });
    if (!sent) return false;
    this.turnPending = true;
    this.queueResponseCreate(this.toolGeneration);
    this.resetIdleTimer();
    return true;
  }

  private resetTurnTracking(): void {
    this.turnPending = false;
    this.outputAudioActive = false;
    this.sawOutputAudioBuffer = false;
    this.lastAssistantText = "";
    if (this.turnIdleTimer !== null) {
      clearTimeout(this.turnIdleTimer);
      this.turnIdleTimer = null;
    }
    this.clearRateLimitRetry();
    this.rateLimitRetries = 0;
  }

  private clearRateLimitRetry(): void {
    if (this.rateLimitRetryTimer !== null) {
      clearTimeout(this.rateLimitRetryTimer);
      this.rateLimitRetryTimer = null;
    }
  }

  /** Re-check turn completion after a short grace, so audio tail and a tool's queued
   *  continuation both get the chance to show up first. */
  private scheduleTurnIdleCheck(): void {
    if (!this.turnPending || this.closing) return;
    if (this.turnIdleTimer !== null) clearTimeout(this.turnIdleTimer);
    const grace = this.sawOutputAudioBuffer ? TURN_IDLE_GRACE_MS : TURN_IDLE_INFERRED_GRACE_MS;
    this.turnIdleTimer = setTimeout(() => {
      this.turnIdleTimer = null;
      if (!this.turnPending || this.closing || !this.connected) return;
      const busy =
        this.hasUnaccountedResponse() ||
        this.queuedResponseCreate ||
        this.responseCreatePending ||
        this.activeToolTerminal !== null ||
        this.outputAudioActive ||
        this.speaking ||
        this.rateLimitRetryTimer !== null;
      if (busy) return;
      this.turnPending = false;
      this.onTurnIdle?.(this.lastAssistantText);
    }, grace);
  }

  // ── Connect / teardown ─────────────────────────────────────────────────────

  /**
   * Establish the WebRTC session. Throws on any setup failure so the caller can
   * fall back to the local stack. On success the mic is live and the model is
   * listening.
   */
  async connect(options: RealtimeConnectOptions = {}): Promise<void> {
    this.timingStarted = performance.now();
    this.timing("connect.start");
    // New conversation → forget the last mirrored lines, so an identical opening
    // line in a fresh session is not swallowed by the de-dup guard.
    resetRealtimeMirror();
    if (!inTauri()) throw new Error("Realtime needs the Praxis desktop app.");
    if (this.connected) return;
    const connectGeneration = ++this.connectGeneration;
    // Praxis's context card (who the owner is, his own details, what the Memory Galaxy knows,
    // the latest job) is fetched alongside the handshake so it costs no connect time.
    const contextCard = fetchContextCard();
    this.closing = false;
    this.connectAbort?.abort();
    const connectAbort = new AbortController();
    this.connectAbort = connectAbort;
    this.pendingResponseIds.clear();
    this.recordingResponseIds.clear();
    this.recordedResponseIds.clear();
    this.toolGeneration += 1;
    this.toolTurnEpoch.invalidate();
    this.responseToolGenerations.clear();
    this.responseAdmissionGenerations = [];
    this.seenResponseIds.clear();
    this.anonymousPendingResponses = 0;
    this.queuedResponseCreate = false;
    this.queuedResponseGeneration = null;
    this.responseCreatePending = false;
    this.retireUnacceptedResponseAdmission(false);
    this.usageUncertain = false;
    this.unmeteredTurns = 0;
    this.unreadableUsageWarned = false;
    this.accountingSessionId = "";
    this.resetTurnTracking();

    // Device startup and the network mint are independent. Keep an outcome
    // promise so early mic rejection is handled while the mint is in flight.
    // A caller that already holds the microphone hands over a CLONED track instead:
    // the transport owns and stops the clone, the caller keeps its own original.
    const stopIfRetired = (stream: MediaStream) => {
      if (this.closing || connectGeneration !== this.connectGeneration) {
        stream.getTracks().forEach((track) => track.stop());
      }
      this.timing("mic.ready");
      return { stream };
    };
    const micReady: Promise<{ stream: MediaStream } | { error: unknown }> = options.inputTrack
      ? Promise.resolve(stopIfRetired(new MediaStream([options.inputTrack])))
      : navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }).then(stopIfRetired, (error: unknown) => ({ error }));
    let session: MintedSession;
    try {
      session = await this.invokeCommand<MintedSession>("mint_realtime_session");
      this.timing("mint.ready");
    } catch (error) {
      void micReady.then((result) => { if ("stream" in result) result.stream.getTracks().forEach((track) => track.stop()); });
      if (isCreditExhausted(error)) noteCreditRefused();
      throw error;
    }
    if (!session.accounting_session_id) {
      void micReady.then((result) => { if ("stream" in result) result.stream.getTracks().forEach((track) => track.stop()); });
      realtimeUsageUncertainLatch = true;
      throw new Error("Realtime accounting reservation was missing.");
    }
    this.accountingSessionId = session.accounting_session_id;
    try {
      await this.assertConnectActive(connectGeneration);

    // 2. Peer connection + remote audio sink.
    const pc = new RTCPeerConnection();
    this.pc = pc;

    this.audioEl = document.createElement("audio");
    this.audioEl.autoplay = true;
    pc.ontrack = (e) => {
      if (this.audioEl && e.streams[0]) {
        this.audioEl.srcObject = e.streams[0];
        this.resumeAudioPlayback();
      }
    };

    // 3. Mic in (this transport OWNS the mic while realtime is live).
    const micResult = await micReady;
    if ("error" in micResult) throw micResult.error;
    this.micStream = micResult.stream;
    await this.assertConnectActive(connectGeneration);
    // A muted track still negotiates the audio sender, so unmuting later (a single
    // turn upgraded to a conversation) needs no renegotiation. OpenAI's server VAD
    // hears only silence from a disabled track and opens no turns of its own.
    const inputEnabled = options.inputEnabled ?? true;
    for (const track of this.micStream.getAudioTracks()) track.enabled = inputEnabled;
    for (const track of this.micStream.getTracks()) pc.addTrack(track, this.micStream);

    // 4. Data channel for events.
    const dc = pc.createDataChannel("oai-events");
    this.bindDataChannel(dc, connectGeneration);

    // 5. SDP offer → OpenAI → answer.
    const offer = await pc.createOffer();
    await this.assertConnectActive(connectGeneration);
    await pc.setLocalDescription(offer);
    await this.assertConnectActive(connectGeneration);

    this.timing("sdp.start");
    const sdpResp = await fetch(session.calls_url, {
      method: "POST",
      body: offer.sdp ?? "",
      headers: {
        Authorization: `Bearer ${session.client_secret}`,
        "Content-Type": "application/sdp",
      },
      signal: connectAbort.signal,
    });
    await this.assertConnectActive(connectGeneration);
    if (!sdpResp.ok) {
      const body = await sdpResp.text().catch(() => "");
      const reason = describeSdpFailure(sdpResp.status, body);
      if (reason === OPENAI_CREDIT_EXHAUSTED) noteCreditRefused();
      throw new Error(reason);
    }
    const answerSdp = await sdpResp.text();
    // OpenAI accepted a paid Realtime call on this key, so any recorded "no credit" is
    // demonstrably stale. This is the clear that makes adding credit take effect on the
    // next chord press with no restart.
    noteCreditAccepted();
    this.timing("sdp.ready");
    await this.assertConnectActive(connectGeneration);
    await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    await this.assertConnectActive(connectGeneration);

    // A WebRTC connection is not usable until OpenAI accepts the complete
    // session.update. Await the acknowledgement (or its correlated error/timeout)
    // before the UI is allowed to report Realtime as connected.
    await this.configureSessionAndWait(session, connectGeneration);
    this.timing("session.accepted");
    await this.assertConnectActive(connectGeneration);
    void contextCard.then((card) => {
      if (!card || connectGeneration !== this.connectGeneration || !this.isConnected()) return;
      this.send({
        type: "conversation.item.create",
        item: { type: "message", role: "system", content: [{ type: "input_text", text: card }] },
      });
      this.timing("context.card");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // "disconnected" IS NOT "failed". Only one of them is terminal.
    //
    // In WebRTC, `disconnected` means ICE has stopped receiving on the selected
    // pair RIGHT NOW - a Wi-Fi blip, a roam between APs, a few lost packets. It
    // recovers on its own most of the time, usually within a couple of seconds,
    // and the spec explicitly allows it to return to `connected`. `failed` is the
    // terminal one.
    //
    // Both were being treated as fatal, so a momentary hiccup tore down a live conversation and
    // handed it to the local lane - which speaks in a DIFFERENT VOICE.
    //
    // So `disconnected` now gets a grace window to heal itself, and the session is
    // only ended if it is still down when the window closes. A recovery cancels it
    // silently, because nothing was ever actually lost.
    // ─────────────────────────────────────────────────────────────────────────
    pc.onconnectionstatechange = () => {
      if (this.closing) return;
      const state = pc.connectionState;

      if (state === "connected") {
        // Healed. Drop any pending teardown without saying anything: from the owner's
        // side the conversation never paused.
        if (this.dropGraceTimer !== null) {
          clearTimeout(this.dropGraceTimer);
          this.dropGraceTimer = null;
        }
        return;
      }

      if (state === "failed" || state === "closed") {
        if (this.dropGraceTimer !== null) {
          clearTimeout(this.dropGraceTimer);
          this.dropGraceTimer = null;
        }
        this.endSession("The realtime connection dropped.", true);
        return;
      }

      if (state === "disconnected") {
        if (this.dropGraceTimer !== null) return; // already counting
        this.dropGraceTimer = setTimeout(() => {
          this.dropGraceTimer = null;
          if (this.closing) return;
          // Still not back, and not recovered to `connected` - now it is real.
          if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
            this.endSession("The realtime connection dropped.", true);
          }
        }, DROP_GRACE_MS);
      }
    };

    this.connected = true;
    // OpenAI took a turn from this wallet, so it is not empty (any longer).
    creditRefusedAt = 0;
    this.resetIdleTimer();
    } catch (error) {
      void micReady.then((result) => { if ("stream" in result) result.stream.getTracks().forEach((track) => track.stop()); });
      if (!this.closing) {
        const accountingSessionId = this.accountingSessionId;
        const uncertain = this.hasUnaccountedResponse() || this.usageUncertain;
        this.closing = true;
    if (this.dropGraceTimer !== null) {
      // A pending "is it really gone?" check must never outlive the session it
      // was watching - it would end the NEXT one.
      clearTimeout(this.dropGraceTimer);
      this.dropGraceTimer = null;
    }
        this.teardown();
        if (uncertain) await this.markUsageUncertain(accountingSessionId);
        else await this.releaseAccountingSession(accountingSessionId);
      }
      throw error;
    }
  }

  /** Send the ONE session.update: stable prompt (caching), tools, voice, VAD. */
  private configureSession(session: MintedSession, eventId: string): boolean {
    return this.send({
      event_id: eventId,
      type: "session.update",
      session: {
        // The GA Realtime endpoint requires the session discriminator on every
        // update. Omitting it establishes the WebRTC connection but makes the
        // provider reject the configuration before any tool can run.
        type: "realtime",
        // Instructions kept identical across sessions so the prompt-cache hits.
        instructions: REALTIME_SYSTEM_PROMPT,
        max_output_tokens: session.max_output_tokens,
        truncation: {
          type: "retention_ratio",
          retention_ratio: 0.8,
          token_limits: { post_instructions: session.post_instruction_tokens },
        },
        // gpt-realtime-2 reasoning kept low for latency.
        reasoning: { effort: session.reasoning_effort },
        // Audio config: the voice was fixed at mint; server_vad turn detection
        // MUST nest under audio.input (the GA /realtime shape - a top-level
        // `turn_detection` on session.update is ignored, which silently disabled
        // auto-response + native barge-in and made realtime feel unresponsive).
        // Verified against OpenAI's live GA realtime docs 2026-07-07.
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              // TUNED 2026-09-09 against two complaints that share this setting.
              //
              // threshold 0.5 -> 0.62. A phantom turn is not a near-miss, it is Praxis acting on
              // something he never said. Raising the bar costs an occasional repeat of a quiet
              // sentence; leaving it costs typing into whatever window happens to be focused.
              threshold: 0.62,
              prefix_padding_ms: 300,
              // 1500 -> 700. This is dead air on EVERY turn: the provider waits
              // this long after he stops talking before the turn even closes, so
              // it was the floor under "the response time is a little slow" and no
              // amount of model speed could get underneath it. 700ms is an
              // ordinary conversational pause and still well above the provider
              // default of 500. Nearly a second off every exchange.
              silence_duration_ms: 700,
              // Responses are created manually only after Rust admits one
              // bounded turn against the current durable accounting lease.
              create_response: false,
              interrupt_response: true,
            },
          },
          output: { voice: session.voice },
        },
        tools: HYBRID_TOOL_SPECS,
        tool_choice: "auto",
      },
    });
  }

  private configureSessionAndWait(
    session: MintedSession,
    connectGeneration: number,
  ): Promise<void> {
    // Every connection generation starts closed to paid-response admission. A
    // provider event can commit buffered audio before its session.updated echo;
    // that early commit is deliberately discarded rather than retained.
    this.retireUnacceptedResponseAdmission(false);
    const dc = this.dc;
    if (!dc) return Promise.reject(new Error("Realtime data channel was unavailable."));
    const eventId = `praxis_session_update_${connectGeneration}_${Date.now()}`;

    return new Promise<void>((resolve, reject) => {
      let sent = false;
      const timer = setTimeout(() => {
        const pending = this.pendingSessionConfiguration;
        if (!pending || pending.eventId !== eventId) return;
        this.pendingSessionConfiguration = null;
        reject(new Error("OpenAI did not acknowledge the Realtime session configuration."));
      }, this.sessionConfigurationTimeoutMs);
      this.pendingSessionConfiguration = {
        eventId,
        connectGeneration,
        expected: {
          model: session.model,
          maxOutputTokens: session.max_output_tokens,
          reasoningEffort: session.reasoning_effort,
          voice: session.voice,
          toolNames: HYBRID_TOOL_SPECS.map((tool) => tool.name),
        },
        timer,
        resolve,
        reject,
      };

      const transmit = () => {
        const pending = this.pendingSessionConfiguration;
        if (
          sent ||
          !pending ||
          pending.eventId !== eventId ||
          this.closing ||
          connectGeneration !== this.connectGeneration
        ) return;
        // Set before send so a readyState/open-event race cannot transmit the
        // same session.update twice.
        sent = true;
        if (!this.configureSession(session, eventId)) {
          this.settleSessionConfiguration(
            new Error("Realtime data channel closed before session configuration."),
          );
        }
      };

      dc.onopen = transmit;
      if (dc.readyState === "open") transmit();
    });
  }

  private bindDataChannel(dc: RTCDataChannel, connectGeneration: number): void {
    this.dc = dc;
    dc.onmessage = (event) => {
      // A queued event from a retired channel must never acknowledge a newer
      // connection's session configuration.
      if (
        this.closing ||
        this.dc !== dc ||
        this.connectGeneration !== connectGeneration
      ) return;
      this.onEvent(event.data);
    };
  }

  private settleSessionConfiguration(error?: Error): void {
    const pending = this.pendingSessionConfiguration;
    if (!pending) return;
    this.pendingSessionConfiguration = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  /**
   * A session.updated event is only an acknowledgement if the provider echoes the
   * safety-critical contract we requested. A syntactically valid but drifted echo
   * must fail the connect gate before the transport can authorize a paid response.
   */
  private validateSessionConfigurationAcknowledgement(
    evt: Record<string, unknown>,
    expected: PendingSessionConfiguration["expected"],
  ): { error: Error | null; automaticResponseUncertain: boolean } {
    const asRecord = (value: unknown): Record<string, unknown> | null =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    const mismatches: string[] = [];
    const session = asRecord(evt.session);
    if (!session) {
      return {
        error: new Error(
          "OpenAI Realtime session acknowledgement did not include a session contract.",
        ),
        // Without an echo we cannot prove server-side auto-response stayed off.
        automaticResponseUncertain: true,
      };
    }

    if (session.type !== "realtime") mismatches.push("type");
    if (session.model !== expected.model) mismatches.push("model");
    if (session.max_output_tokens !== expected.maxOutputTokens) {
      mismatches.push("max_output_tokens");
    }

    const reasoning = asRecord(session.reasoning);
    if (reasoning?.effort !== expected.reasoningEffort) mismatches.push("reasoning.effort");

    const audio = asRecord(session.audio);
    const input = asRecord(audio?.input);
    const turnDetection = asRecord(input?.turn_detection);
    const output = asRecord(audio?.output);
    if (output?.voice !== expected.voice) mismatches.push("audio.output.voice");
    const automaticResponseUncertain = turnDetection?.create_response !== false;
    if (automaticResponseUncertain) {
      mismatches.push("audio.input.turn_detection.create_response");
    }
    if (turnDetection?.interrupt_response !== true) {
      mismatches.push("audio.input.turn_detection.interrupt_response");
    }

    if (session.tool_choice !== "auto") mismatches.push("tool_choice");
    const tools = Array.isArray(session.tools) ? session.tools : null;
    const toolNames = tools?.every((tool) => {
      const spec = asRecord(tool);
      return spec?.type === "function" && typeof spec.name === "string";
    })
      ? tools.map((tool) => (tool as Record<string, unknown>).name as string)
      : null;
    const expectedToolNames = [...expected.toolNames].sort();
    const echoedToolNames = toolNames ? [...toolNames].sort() : null;
    if (
      !echoedToolNames ||
      echoedToolNames.length !== expectedToolNames.length ||
      echoedToolNames.some((name, index) => name !== expectedToolNames[index])
    ) {
      mismatches.push("tools");
    }

    return {
      error: mismatches.length > 0
        ? new Error(
            `OpenAI Realtime session acknowledgement did not match the requested configuration: ${mismatches.join(", ")}.`,
          )
        : null,
      automaticResponseUncertain,
    };
  }

  private retireUnacceptedResponseAdmission(automaticResponseUncertain: boolean): void {
    this.sessionConfigurationAcceptedGeneration = null;
    // A commit received before acceptance is not a future user request. Never
    // replay it if another acknowledgement or connection later succeeds.
    this.queuedResponseCreate = false;
    this.queuedResponseGeneration = null;
    if (automaticResponseUncertain && !this.hasUnaccountedResponse()) {
      // A provider that echoed create_response=true may already be synthesizing a
      // response without our response.create. Preserve the exact lease as
      // uncertain until durable accounting can reconcile it.
      this.anonymousPendingResponses = 1;
    }
  }

  private send(obj: unknown): boolean {
    if (this.closing) return false;
    if (this.dc && this.dc.readyState === "open") {
      try {
        this.dc.send(JSON.stringify(obj));
        return true;
      } catch {
        /* channel closing - ignore */
      }
    }
    return false;
  }

  // ── Event loop ─────────────────────────────────────────────────────────────

  private onEvent(raw: unknown): void {
    if (this.closing) return;
    if (typeof raw !== "string") return;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof evt.type === "string" ? evt.type : "";

    switch (type) {
      case "session.updated": {
        const pending = this.pendingSessionConfiguration;
        if (!pending) break;
        const validation = this.validateSessionConfigurationAcknowledgement(evt, pending.expected);
        if (
          validation.error ||
          this.closing ||
          pending.connectGeneration !== this.connectGeneration
        ) {
          this.retireUnacceptedResponseAdmission(validation.automaticResponseUncertain);
          this.settleSessionConfiguration(
            validation.error ?? new Error("Realtime connect was cancelled."),
          );
          break;
        }
        // bindDataChannel already proved this came from the exact current channel;
        // bind acceptance to that same generation before resolving connect().
        this.sessionConfigurationAcceptedGeneration = pending.connectGeneration;
        this.settleSessionConfiguration();
        break;
      }

      case "error": {
        const detail = evt.error && typeof evt.error === "object"
          ? evt.error as Record<string, unknown>
          : {};
        const eventId = typeof detail.event_id === "string" ? detail.event_id : "";
        const message = typeof detail.message === "string"
          ? detail.message.slice(0, 180)
          : "OpenAI rejected the Realtime session configuration.";
        if (
          this.pendingSessionConfiguration &&
          eventId === this.pendingSessionConfiguration.eventId
        ) {
          this.settleSessionConfiguration(new Error(`OpenAI Realtime configuration failed: ${message}`));
        }
        break;
      }

      case "response.created":
        this.timing("response.created");
        if (!this.responseId(evt)) {
          // A response without an ID cannot be bound to its authorized user-turn
          // generation. Tear down now; teardown retires the orphan FIFO admission.
          this.endSession("OpenAI returned an unidentifiable response — switching to the local voice.", true);
          break;
        }
        if (!this.bindResponseToolGeneration(evt)) {
          this.endSession(
            "OpenAI returned a duplicate or unadmitted response — switching to the local voice.",
            true,
          );
          break;
        }
        this.noteResponseStarted(evt);
        break;

      // Model started producing audio → we're "speaking".
      case "response.output_audio.delta":
      case "response.audio.delta":
        this.noteResponseStarted(evt);
        this.resumeAudioPlayback();
        this.setSpeaking(true);
        this.resetIdleTimer();
        break;

      // Model finished this response's audio → not speaking.
      case "response.output_audio.done":
      case "response.audio.done":
        this.setSpeaking(false);
        this.scheduleTurnIdleCheck();
        break;

      // WebRTC only: the server-side output buffer began / finished draining to us.
      // Generation can finish well before the last word is heard, so this, not
      // `response.output_audio.done`, is what marks a spoken turn as over.
      case "output_audio_buffer.started":
        this.sawOutputAudioBuffer = true;
        this.outputAudioActive = true;
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.sawOutputAudioBuffer = true;
        this.outputAudioActive = false;
        this.scheduleTurnIdleCheck();
        break;

      // ── Transcripts → the Atlas chat panel ──────────────────────────────────
      // A Realtime conversation used to leave NOTHING in the Atlas thread: the
      // hybrid lane mirrors a finished turn as a pair, but here the two halves
      // arrive as separate provider events, so each is mirrored as it finalizes.
      // (The user side only exists at all because the session now requests
      // input transcription - see openai_realtime.rs.)
      case "conversation.item.input_audio_transcription.completed":
      case "conversation.item.audio_transcription.completed": {
        const said = typeof evt.transcript === "string" ? evt.transcript : "";
        if (said.trim()) mirrorRealtimeTurn("zach", said);
        break;
      }

      // What Atlas said back, as text.
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        const spoke = typeof evt.transcript === "string" ? evt.transcript : "";
        if (spoke.trim()) {
          this.lastAssistantText = spoke.trim();
          mirrorRealtimeTurn("agent", spoke);
        }
        break;
      }

      // Native barge-in: the user started talking. Server VAD interrupts the model
      // for us (interrupt_response: true). Abort only this Realtime turn's tool
      // controller; a mere speech start is not a global HALT and must not tear down
      // detached work or the persistent Sovereign browser service.
      case "input_audio_buffer.speech_started":
        if (this.turnIdleTimer !== null) {
          clearTimeout(this.turnIdleTimer);
          this.turnIdleTimer = null;
        }
        this.clearRateLimitRetry();
        this.invalidateToolTurn();
        if (this.pendingOwnerToken) {
          void this.queueOwnedOperatorStop(this.pendingOwnerToken).catch(() => {
            // Retained by the queue; a replacement cannot admit on uncertainty.
          });
        }
        this.toolAbort?.abort();
        this.setSpeaking(false);
        this.resetIdleTimer();
        break;

      case "input_audio_buffer.committed":
        this.timing("input.committed");
        this.turnPending = true;
        this.queueResponseCreate(this.toolGeneration);
        this.resetIdleTimer();
        break;

      // The model wants to call a tool. Dispatch through the shared router.
      case "response.function_call_arguments.done":
        this.noteResponseStarted(evt);
        void this.handleToolCall(evt);
        break;

      // End of a response - capture usage for the ledger + cap check.
      case "response.done":
        this.setSpeaking(false);
        {
          const responseId = this.responseId(evt);
          if (responseId) this.responseToolGenerations.delete(responseId);
        }
        void this.handleResponseDone(evt);
        break;

      default:
        break;
    }
  }

  private queueResponseCreate(generation = this.toolGeneration): void {
    if (
      this.closing ||
      generation !== this.toolGeneration ||
      this.sessionConfigurationAcceptedGeneration !== this.connectGeneration
    ) return;
    this.queuedResponseCreate = true;
    this.queuedResponseGeneration = generation;
    void this.flushQueuedResponseCreate();
  }

  private async flushQueuedResponseCreate(): Promise<void> {
    if (this.sessionConfigurationAcceptedGeneration !== this.connectGeneration) {
      this.queuedResponseCreate = false;
      this.queuedResponseGeneration = null;
      return;
    }
    if (
      this.closing ||
      !this.queuedResponseCreate ||
      this.queuedResponseGeneration === null ||
      this.responseCreatePending ||
      this.hasUnaccountedResponse()
    ) return;
    const accountingSessionId = this.accountingSessionId;
    const connectionGeneration = this.connectGeneration;
    const acceptedConnectionGeneration = this.sessionConfigurationAcceptedGeneration;
    const responseGeneration = this.queuedResponseGeneration;
    if (responseGeneration !== this.toolGeneration) {
      this.queuedResponseCreate = false;
      this.queuedResponseGeneration = null;
      return;
    }
    if (!accountingSessionId) {
      this.endSession("Realtime accounting lease was unavailable — switching to the local voice.");
      return;
    }

    this.responseCreatePending = true;
    try {
      this.timing("admission.start");
      const spent = await this.invokeCommand<number>("authorize_realtime_response", { accountingSessionId });
      this.timing("admission.ready");
      if (
        this.closing ||
        connectionGeneration !== this.connectGeneration ||
        acceptedConnectionGeneration !== connectionGeneration ||
        this.sessionConfigurationAcceptedGeneration !== acceptedConnectionGeneration ||
        accountingSessionId !== this.accountingSessionId ||
        responseGeneration !== this.toolGeneration ||
        responseGeneration !== this.queuedResponseGeneration
      ) return;
      if (typeof spent !== "number" || !Number.isFinite(spent) || spent < 0) {
        throw new Error("untrusted cumulative spend");
      }
      readyCache = { ...readyCache, spent_usd: spent };
      this.queuedResponseCreate = false;
      this.queuedResponseGeneration = null;
      // Reserve an anonymous in-memory response identity before the provider can
      // observe response.create. response.created later replaces it with the ID.
      this.anonymousPendingResponses += 1;
      this.responseAdmissionGenerations.push(responseGeneration);
      if (!this.send({ type: "response.create" })) {
        this.anonymousPendingResponses = Math.max(0, this.anonymousPendingResponses - 1);
        this.responseAdmissionGenerations.pop();
        throw new Error("realtime data channel unavailable");
      }
    } catch {
      if (!this.closing) {
        this.endSession(
          "OpenAI Realtime response admission failed — switching to the local voice before another paid turn.",
        );
      }
    } finally {
      this.responseCreatePending = false;
      // A newer utterance can queue while an older authorization is in flight.
      // Give that retained generation its own admission pass once this one exits.
      if (!this.closing && this.queuedResponseCreate) void this.flushQueuedResponseCreate();
    }
  }

  /** Dispatch a function call through the existing router and return the result. */
  private async handleToolCall(evt: Record<string, unknown>): Promise<void> {
    if (this.closing) return;
    const name = typeof evt.name === "string" ? evt.name : "";
    this.timing("tool.requested");
    const callId = typeof evt.call_id === "string" ? evt.call_id : "";
    const originatingGeneration = this.toolEventGeneration(evt);
    if (originatingGeneration === null || originatingGeneration !== this.toolGeneration) {
      // Unknown/missing response provenance and every retired response fail closed.
      // Complete the provider call so its item is not left dangling, but never
      // admit a tool owner or ask for another paid model response.
      if (callId) {
        this.send({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output: "Stopped." },
        });
      }
      return;
    }
    const claimedEpoch = this.toolTurnEpoch.begin();
    let args: Record<string, unknown> = {};
    if (typeof evt.arguments === "string" && evt.arguments.trim()) {
      try {
        args = JSON.parse(evt.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }
    }

    let output = "Done.";
    /** Set by a vision tool (screenshot) - added to the conversation as an image. */
    let toolImage: string | null = null;
    const interruptedOwner = this.pendingOwnerToken;
    const priorToolTerminal = this.activeToolTerminal ?? Promise.resolve();
    const stopTargetOwners = new Set(this.detachedOwnerTokens);
    if (interruptedOwner) stopTargetOwners.add(interruptedOwner);
    this.toolAbort?.abort();
    for (const retainedOwner of getUnresolvedOperatorOwners()) {
      void this.queueOwnedOperatorStop(retainedOwner).catch(() => {
        // The serialized queue keeps this exact owner and admission closed.
      });
    }
    const priorStop = this.queueOwnedOperatorStop(interruptedOwner);
    const current = await waitForCurrentOperatorTurn(
      this.toolTurnEpoch,
      claimedEpoch,
      Promise.all([priorStop, priorToolTerminal]),
      () => this.closing || originatingGeneration !== this.toolGeneration,
    );
    if (!current) {
      // Complete the superseded provider call without admitting a tool/owner.
      // The newest tool call will request the next response once it finishes.
      if (!this.closing && callId) {
        this.send({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: callId, output: "Stopped." },
        });
      }
      return;
    }
    const ownerToken = createOperatorOwnerToken("realtime");
    const controller = new AbortController();
    let resolveToolTerminal: () => void = () => {};
    const toolTerminal = new Promise<void>((resolve) => {
      resolveToolTerminal = resolve;
    });
    this.activeToolTerminal = toolTerminal;
    this.toolAbort = controller;
    this.pendingOwnerToken = ownerToken;
    try {
      this.timing("tool.start");
      const res = await dispatchToolCall(
        name,
        args,
        async () => {
          this.stopSpeaking();
          if (stopTargetOwners.size === 0) {
            return {
              orchestration: "idle",
              unattended: "idle",
              computerUse: "idle",
              sovereign: "idle",
              native: "idle",
              terminal: true,
            };
          }
          const result = await stopOperatorOwners(stopTargetOwners);
          if (result.terminal) {
            for (const owner of stopTargetOwners) this.detachedOwnerTokens.delete(owner);
          }
          return result;
        },
        controller.signal,
        ownerToken,
      );
      const stillCurrent =
        !controller.signal.aborted &&
        !this.closing &&
        originatingGeneration === this.toolGeneration;
      output = stillCurrent ? res.output : "Stopped.";
      if (stillCurrent && res.image) toolImage = res.image;
      if (stillCurrent && (res.resolution === "escalated" || res.resolution === "unattended")) {
        this.detachedOwnerTokens.add(ownerToken);
      }
      if (stillCurrent && this.onFeedItem) this.onFeedItem(res.item);
    } catch (err) {
      output = controller.signal.aborted || originatingGeneration !== this.toolGeneration
        ? "Stopped."
        : `That didn't work: ${String(err).slice(0, 80)}`;
    } finally {
      this.timing("tool.end");
      if (this.toolAbort === controller) this.toolAbort = null;
      if (this.pendingOwnerToken === ownerToken) this.pendingOwnerToken = null;
      resolveToolTerminal();
      if (this.activeToolTerminal === toolTerminal) this.activeToolTerminal = null;
    }

    // A vision tool's IMAGE must enter the conversation as its own user message -
    // a function_call_output carries text only, so without this the model would be
    // told "screenshot captured" and still not see anything. Sent BEFORE the tool
    // output so the image is already in context when the model reasons about it.
    // (gpt-realtime image input: conversation.item.create → message → input_image.)
    if (callId && toolImage && !controller.signal.aborted && !this.closing) {
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: toolImage, detail: "high" }],
        },
      });
    }

    // Return the tool result to the model, then let it speak the outcome.
    if (callId) {
      this.send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output },
      });
      if (
        !controller.signal.aborted &&
        !this.closing &&
        originatingGeneration === this.toolGeneration
      ) this.queueResponseCreate(originatingGeneration);
    }
    this.resetIdleTimer();
    // A superseded or stopped tool asks for no continuation, so this may be the
    // turn's last step. The check stays quiet while a continuation is queued.
    this.scheduleTurnIdleCheck();
  }

  
  private async handleResponseDone(evt: Record<string, unknown>): Promise<void> {
    const responseId = this.responseId(evt);
    if (!responseId) {
      this.endSession("OpenAI returned an unidentifiable response — switching to the local voice.", true);
      return;
    }
    if (this.recordedResponseIds.has(responseId) || this.recordingResponseIds.has(responseId)) return;
    this.noteResponseStarted(evt);
    this.recordingResponseIds.add(responseId);
    const response = (evt.response ?? {}) as Record<string, unknown>;
    // A response that ends without finishing (token cap, content filter, a cancel)
    // silently ends Atlas's chain of tool calls - 2026-09-24 a dictated email stopped
    // after the recipient with nothing on screen to say why. Say why.
    const status = typeof response.status === "string" ? response.status : "";
    if (status && status !== "completed") {
      const items = Array.isArray(response.output)
        ? (response.output as Array<Record<string, unknown>>).map((o) => String(o?.type ?? "?")).join(",")
        : "";
      console.warn(
        `[realtime] response ${responseId} ended "${status}" ` +
          `${JSON.stringify(response.status_details ?? {}).slice(0, 300)} output=[${items}]`,
      );
    }
    if (status === "completed") this.rateLimitRetries = 0;
    // OpenAI's tokens-per-minute limit ends a chain mid-job: every step re-sends the
    // whole conversation (~5.6k tokens) and the org's Realtime limit is 40k/min, so the
    // 7th step of a dictated email failed and Atlas simply stopped (measured 2026-09-24:
    // "Limit 40000, Used 40000, Requested 5644. Please try again in 8.466s"). Wait the
    // time OpenAI names and resume the same turn; speaking cancels the resume.
    const details = (response.status_details ?? {}) as Record<string, unknown>;
    const failure = (details.error ?? {}) as Record<string, unknown>;
    if (status === "failed" && failure.code === "rate_limit_exceeded" && !this.closing && this.rateLimitRetries < 3) {
      const named = /try again in ([\d.]+)\s*s/i.exec(String(failure.message ?? ""));
      const waitMs = Math.min(30_000, Math.max(1_500, Math.ceil((named ? Number(named[1]) : 8) * 1000) + 400));
      this.rateLimitRetries += 1;
      const generation = this.toolGeneration;
      this.clearRateLimitRetry();
      console.warn(
        `[realtime] OpenAI tokens-per-minute limit — resuming this turn in ${(waitMs / 1000).toFixed(1)}s ` +
          `(retry ${this.rateLimitRetries}/3)`,
      );
      this.rateLimitRetryTimer = setTimeout(() => {
        this.rateLimitRetryTimer = null;
        if (!this.closing && generation === this.toolGeneration) this.queueResponseCreate(generation);
        else this.scheduleTurnIdleCheck();
      }, waitMs);
    }
    const usage = extractUsage(response.usage);
    if (!usage) {
      // AN ACCOUNTING GAP IS NOT A REASON TO STOP TALKING.
      //
      // This used to end the session outright, so Atlas died mid-conversation and fell back to
      // the local voice the moment OpenAI sent a `response.done` whose usage block did not match
      // `extractUsage`'s exact expectations - a missing token-details object, an unfamiliar
      // field, or any image tokens at all.
      //
      // The cost of not knowing one turn's tokens is that the spend estimate is
      // slightly low and openly flagged. The cost of ending the session is the
      // whole feature. Mark the session's accounting uncertain - which is true,
      // and which the cap logic already understands - and keep the conversation.
      // Counted, not latched. `markUsageUncertain` would ALSO set
      // `realtimeUsageUncertainLatch` and blank `readyCache.ready`, which disables
      // Realtime for every FUTURE session too - the same orphaned-marker latch
      // that had Atlas silently running on the local voice for weeks. One turn
      // with an unfamiliar usage shape is not an accounting integrity failure and
      // must not cost the feature.
      //
      // Marking the response recorded is deliberate: it stops the session-end
      // orphan check from treating this as a response that vanished, which is the
      // case the hard latch genuinely exists for.
      this.unmeteredTurns += 1;
      this.recordedResponseIds.add(responseId);
      this.recordingResponseIds.delete(responseId);
      // Clear it from the PENDING set too, or the session-end orphan check sees a
      // response that started and never finished and latches the feature off on
      // disconnect - the very outcome this branch exists to avoid. Unmetered is a
      // resolved outcome, not an unfinished one.
      this.noteResponseRecorded(evt);
      const raw = this.unreadableUsageWarned
        ? ""
        : ` Raw usage: ${usageJsonSnippet(response.usage)}`;
      this.unreadableUsageWarned = true;
      console.warn(
        `[realtime] usage block unreadable for ${responseId}; turn is unmetered ` +
          `(${this.unmeteredTurns} this session). Conversation continues; the spend ` +
          `estimate for this session is a floor, not a total.${raw}`,
      );
      // A fast tool may already have queued its continuation while this response
      // was pending. Unmetered is resolved too; wake that queue just as the
      // trustworthy-usage branch does, rather than waiting for another utterance.
      void this.flushQueuedResponseCreate();
      this.scheduleTurnIdleCheck();
      return;
    }
    let recorded = false;
    try {
      const spent = await this.invokeCommand<number>("record_realtime_usage", {
        usage,
        accountingSessionId: this.accountingSessionId,
      });
      if (typeof spent !== "number" || !Number.isFinite(spent) || spent < 0) {
        throw new Error("untrusted cumulative spend");
      }
      this.noteResponseRecorded(evt);
      this.recordedResponseIds.add(responseId);
      // The durable record is the accounting boundary. Clear the transient
      // writer marker before cap teardown or queued admission inspects it.
      this.recordingResponseIds.delete(responseId);
      recorded = true;
      readyCache = { ...readyCache, spent_usd: spent };
      if (spent >= readyCache.cap_usd) {
        this.endSession(
          `OpenAI Realtime admission cutoff reached ($${spent.toFixed(2)} / $${readyCache.cap_usd.toFixed(2)}) — switching to the local voice.`,
        );
      } else {
        void this.flushQueuedResponseCreate();
        this.scheduleTurnIdleCheck();
      }
    } catch {
      // Keep the response pending/recording markers intact until endSession has
      // classified the lease as uncertain and synchronously quiesced transport.
      this.endSession("OpenAI usage ledger unavailable — switching to the local voice.", true);
    } finally {
      if (!recorded) this.recordingResponseIds.delete(responseId);
    }
  }

  // ── Speaking state ─────────────────────────────────────────────────────────

  private responseId(evt: Record<string, unknown>): string {
    const response = (evt.response ?? {}) as Record<string, unknown>;
    const candidate = typeof response.id === "string"
      ? response.id
      : typeof evt.response_id === "string"
        ? evt.response_id
        : "";
    // Provider IDs are opaque, but blank or padded values are not identities.
    // Reject them instead of normalizing so a malformed event can never consume
    // the next anonymous response admission or authorize later tool events.
    return candidate && candidate === candidate.trim() ? candidate : "";
  }

  private noteResponseStarted(evt: Record<string, unknown>): void {
    const id = this.responseId(evt);
    if (id) {
      if (this.recordedResponseIds.has(id)) return;
      if (
        !this.pendingResponseIds.has(id) &&
        this.anonymousPendingResponses > 0
      ) {
        this.anonymousPendingResponses -= 1;
      }
      this.pendingResponseIds.add(id);
    } else if (evt.type === "response.created") this.anonymousPendingResponses += 1;
    else if (this.anonymousPendingResponses === 0) this.anonymousPendingResponses = 1;
  }

  private noteResponseRecorded(evt: Record<string, unknown>): void {
    const id = this.responseId(evt);
    if (id) this.pendingResponseIds.delete(id);
    else this.anonymousPendingResponses = Math.max(0, this.anonymousPendingResponses - 1);
  }

  private hasUnaccountedResponse(): boolean {
    return (
      this.pendingResponseIds.size > 0 ||
      this.recordingResponseIds.size > 0 ||
      this.anonymousPendingResponses > 0
    );
  }

  private async markUsageUncertain(
    accountingSessionId = this.accountingSessionId,
  ): Promise<void> {
    if (this.usageUncertain) return;
    this.usageUncertain = true;
    realtimeUsageUncertainLatch = true;
    readyCache = {
      ...readyCache,
      ready: false,
      reason: "OpenAI realtime usage is uncertain; using the local voice until accounting is repaired.",
    };
    try {
      await this.invokeCommand<void>("mark_realtime_usage_uncertain", {
        accountingSessionId,
      });
    } catch {
      // The webview is already fail-closed. Rust flips its process-local guard
      // before attempting to persist the marker, so either side blocks a remint.
    }
  }

  private async releaseAccountingSession(
    accountingSessionId = this.accountingSessionId,
  ): Promise<void> {
    if (!accountingSessionId) return;
    readyCache = {
      ...readyCache,
      ready: false,
      reason: "Closing the prior realtime accounting session.",
    };
    try {
      await this.invokeCommand<void>("close_realtime_accounting_session", { accountingSessionId });
      if (this.accountingSessionId === accountingSessionId) this.accountingSessionId = "";
    } catch {
      // The durable reservation remains in place. Rust will reject every later
      // readiness check and mint until that exact marker is reconciled.
    }
  }

  private async assertConnectActive(connectGeneration: number): Promise<void> {
    if (!this.closing && connectGeneration === this.connectGeneration) return;
    const accountingSessionId = this.accountingSessionId;
    const uncertain = this.hasUnaccountedResponse() || this.usageUncertain;
    this.teardown();
    if (uncertain) await this.markUsageUncertain(accountingSessionId);
    else await this.releaseAccountingSession(accountingSessionId);
    throw new Error("Realtime connect was cancelled.");
  }

  private setSpeaking(v: boolean): void {
    if (this.speaking === v) return;
    this.speaking = v;
    for (const fn of this.speakingListeners) fn(v);
  }

  // ── Idle timer ─────────────────────────────────────────────────────────────

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // Async tool completions can arrive after teardown. Never let a late
    // completion re-arm a timer on a closed transport.
    if (this.closing) return;
    this.idleTimer = setTimeout(() => {
      this.endSession("Paused after a quiet stretch — press the chord to talk again.", false, "idle");
    }, IDLE_DISCONNECT_MS);
  }

  /** End the session and notify the hook so it can fall back / show a notice. */
  private endSession(reason: string, forceUsageUncertain = false, kind: "idle" | "failure" = "failure"): void {
    if (this.closing) return;
    const accountingSessionId = this.accountingSessionId;
    const uncertain = forceUsageUncertain || this.usageUncertain || this.hasUnaccountedResponse();
    this.closing = true;
    if (this.dropGraceTimer !== null) {
      // A pending "is it really gone?" check must never outlive the session it
      // was watching - it would end the NEXT one.
      clearTimeout(this.dropGraceTimer);
      this.dropGraceTimer = null;
    }
    // Quiesce synchronously before any IPC can remove the durable lease.
    this.teardown();
    this.onSessionEnd?.(reason, kind);
    if (uncertain) void this.markUsageUncertain(accountingSessionId);
    else void this.releaseAccountingSession(accountingSessionId);
  }

  private resumeAudioPlayback(): void {
    const audio = this.audioEl;
    if (!audio || !audio.paused) return;
    try {
      const playback = audio.play();
      if (playback && typeof playback.catch === "function") {
        void playback.catch(() => {
          // Autoplay policy or teardown can race this best-effort re-arm.
        });
      }
    } catch {
      // The next audio delta retries; connection state remains authoritative.
    }
  }

  /** Public disconnect (called by the hook when the session ends). Idempotent. */
  disconnect(): void {
    if (this.closing) return;
    const accountingSessionId = this.accountingSessionId;
    const uncertain = this.usageUncertain || this.hasUnaccountedResponse();
    this.teardown();
    if (uncertain) void this.markUsageUncertain(accountingSessionId);
    else void this.releaseAccountingSession(accountingSessionId);
  }

  private teardown(): void {
    this.closing = true;
    if (this.dropGraceTimer !== null) {
      // A pending "is it really gone?" check must never outlive the session it
      // was watching - it would end the NEXT one.
      clearTimeout(this.dropGraceTimer);
      this.dropGraceTimer = null;
    }
    this.sessionConfigurationAcceptedGeneration = null;
    this.settleSessionConfiguration(new Error("Realtime connect was cancelled."));
    this.invalidateToolTurn();
    this.resetTurnTracking();
    this.connectGeneration += 1;
    this.connectAbort?.abort();
    this.connectAbort = null;
    this.connected = false;
    this.queuedResponseCreate = false;
    this.queuedResponseGeneration = null;
    this.responseToolGenerations.clear();
    this.responseAdmissionGenerations = [];
    this.seenResponseIds.clear();
    const controller = this.toolAbort;
    const pendingOwner = this.pendingOwnerToken;
    const detachedOwners = [...this.detachedOwnerTokens];
    this.toolAbort = null;
    const stopped = stopOperatorSessionRuns(controller, pendingOwner, detachedOwners);
    void stopped.then(
      (result) => {
        if (!result.terminal) return;
        if (this.pendingOwnerToken === pendingOwner) this.pendingOwnerToken = null;
        for (const owner of detachedOwners) this.detachedOwnerTokens.delete(owner);
      },
      () => {
        // Exact owners remain retained for the next session/global HALT retry.
      },
    );
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    try {
      this.dc?.close();
    } catch {
      /* noop */
    }
    this.dc = null;
    // Release the mic - CRITICAL so the local stack can own it after fallback and
    // the two transports never hold the mic at once.
    this.micStream?.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* noop */
      }
    });
    this.micStream = null;
    try {
      this.pc?.close();
    } catch {
      /* noop */
    }
    this.pc = null;
    if (this.audioEl) {
      try {
        this.audioEl.srcObject = null;
      } catch {
        /* noop */
      }
      this.audioEl = null;
    }
    this.setSpeaking(false);
  }
}
