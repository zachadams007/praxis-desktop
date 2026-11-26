import { newMissionId, missionTitle, postMissionMsg, loadMissionThread } from "@/orchestrator/missionThread";
import { speakable } from "@/orchestrator/missionText";
/**
 * hybridRouter - the Hybrid Praxis FAST ROUTER.
 *
 * Per finalized utterance, in STRICT latency order (each rung only runs if the
 * cheaper ones didn't match):
 *
 *   a. parseCommand() - existing voice grammar (window/monitor/close/open/media
 *                            /view/transport/capture…). Executes instantly as today.
 *   b. native op - native_op_try (open app/url/search, focus window, media
 *                            keys). Instant, zero spend, no Codex.
 *   c. direct-input - hybrid type/press/scroll via enigo (hybridActions).
 *                            "type this: …", "press enter", "scroll down" - instant,
 *                            visible, no Codex.
 *   d. brain classify - anything unmatched → the fast NIM brain buckets it into
 *                            QUICK_ACTION | ANSWER | TODO | ESCALATE and we act:
 *                              QUICK_ACTION → re-run through a/b/c primitives
 *                              ANSWER       → answer via the SHARED ask() path (Atlas
 *                                             answers from Praxis's memory, not a bare
 *                                             context-free classifier guess)
 *                              TODO         → capture onto the Command Center to-do
 *                              ESCALATE     → hand to Mission (orchestrate()) - but ONLY
 *                                             when the utterance carries a real goal verb
 *                                             (GOAL_RE/UNATTENDED_RE, the never-escalate
 *                                             guard). Conversation NEVER reaches the loop.
 *
 * IDENTITY: this fast lane is ATLAS - Praxis's front-of-house voice. It answers now,
 * operates the computer, and hands heavy multi-step work to MISSION (the deep builder).
 * A degraded/timed-out brain falls back to answering, never to the multi-minute loop.
 *
 * Two pure classification helpers live in hybridClassify.ts (local pre-classify +
 * the brain classify prompt/parse) so the decision logic is unit-testable headless.
 *
 * The router reports every resolution back to the caller via a `HybridFeedItem` so
 * the session panel can render the utterance + what happened to it, and speaks
 * confirmations through the injected transport (barge-in aware).
 */

import type { ActionOrigin } from "@/shared/actionOrigin";
import { parseCommand } from "./commands";
import { areaRefs, executeVoiceCommand } from "./execute";
import { classifyLocal, classifyPrompt, isImperativeBuildGoal, parseClassify } from "./hybridClassify";
import { hybridType, hybridPress, hybridScroll } from "./hybridActions";
import { captureTodo } from "./todoBridge";
import type { HybridTransport } from "./hybridTransport";
import { operatorActionBlockedReason } from "./operatorPolicy";
import { voiceCommandNeedsDesktop } from "./operatorPolicyCore";
import { currentExecMode, isHalted } from "@/orchestrator/policy";
// The ONE shared sovereign gate - same sensitivity test + Trust-IV check + entry
// point the Mission input and Atlas's escalate tool use, so all three surfaces agree
// on what's sensitive and what happens at each trust level. SENSITIVE_RE is re-exported
// from here as the single source of truth (the local copy that used to live in this
// file is gone).
import { sensitiveGoal, routeSovereign } from "@/shared/sovereignGate";
import type { OperatorStopResult } from "./stopOperatorRuns";
// The SAME goal/unattended intent tests the unified Mission input uses - reused here
// (not duplicated) so the fast lane and the deep lane agree on what counts as a real
// "go build this" goal versus ordinary conversation. This is the spine of the
// never-escalate guard: conversational input can never fall into orchestrate().
import { GOAL_RE, UNATTENDED_RE } from "@/orchestrator/submitClassify";
import { startOwnedOrchestration } from "@/orchestrator/ownedRuns";
import { explicitWebSearchQuery, searchWebAnswer, webSearchSpokenBrief } from "./webSearchAnswer";

// ── Feed item - one line in the session panel's finalized-utterance list ──────

export type HybridResolution =
  | "command" // an existing Praxis verb ran (grammar)
  | "action" // a native op or direct-input primitive ran
  | "answer" // a spoken conversational reply
  | "todo" // captured onto the to-do list
  | "escalated" // handed to the background orchestrator (single named task)
  | "unattended" // handed to the background orchestrator as a long-horizon multi-task run
  | "halt" // stop/cancel - aborted the current action (and any unattended run)
  | "blocked" // trust gate / disabled tool refused it
  | "ignored"; // empty / nothing to do

export interface HybridFeedItem {
  id: string;
  transcript: string;
  resolution: HybridResolution;
  /** Short line describing what happened (also spoken for answers/actions). */
  detail: string;
  /** Rich text for the Atlas transcript when speech deliberately stays concise. */
  displayMarkdown?: string;
  ts: number;
}

/** Controls the router exposes to the session hook for abort/escalation wiring. */
export interface HybridRouterContext {
  transport: HybridTransport;
  /** Aborts late classifier/tool results so a barge-in cannot dispatch new work. */
  signal?: AbortSignal;
  /** Per-turn owner token for detached operator/Sovereign/unattended work. */
  ownerToken?: string;
  /** Called when a "stop/cancel/never mind" utterance should abort in-flight work. */
  onHalt: () => void | OperatorStopResult | Promise<void | OperatorStopResult>;
  /** Emit a finished feed item to the UI. */
  emit: (item: HybridFeedItem) => void;
  /**
   * Typed into Mission, not spoken (orchestrator/operator.ts). Nothing speaks, and the
   * router stops before its voice fallbacks (the build hand-off and the classifier),
   * returning "ignored" so Praxis's operator loop can finish the task with Atlas's tools.
   */
  typed?: boolean;
}

let feedSeq = 0;
function feedId(): string {
  return `hf-${Date.now()}-${feedSeq++}`;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

// ── The live-path gate ───────────────────────────────────────────────────────

/**
 * What survives is HALT, the Computer Use master breaker, and "there is no desktop shell here".
 * See src/shared/actionOrigin.ts.
 *
 * Returns null when allowed, or a spoken refusal string when blocked.
 */
function directInputGate(text: string): string | null {
  return operatorActionBlockedReason(text, "direct-input", "live");
}

// ── The native-op rung ───────────────────────────────────────────────────────

type NativeAttempt =
  | { kind: "unmatched" }
  | { kind: "blocked"; message: string }
  | { kind: "done"; message: string }
  | { kind: "failed"; message: string };

function nativeFailureMessage(err: unknown): string {
  const raw = String(err ?? "").trim();
  if (!raw) return "That local desktop action failed.";
  const stripped = raw.replace(/^.*?failed:\s*/i, "").trim();
  const msg = (stripped || raw).replace(/^"|"$/g, "").trim();
  return msg.slice(0, 220) || "That local desktop action failed.";
}

async function tryNativeOp(
  text: string,
  signal?: AbortSignal,
  ownerToken?: string,
): Promise<NativeAttempt> {
  if (!inTauri()) return { kind: "unmatched" };
  if (signal?.aborted) return { kind: "blocked", message: "Stopped." };

  // Probe separately from execution: a probe outage is unknown and may continue
  // to the allowed next rung. Only matches=true followed by an execution failure
  // is a local terminal result.
  let matches = false;
  try {
    matches = await tauriInvoke<boolean>("native_op_matches", { goal: text });
  } catch {
    return { kind: "unmatched" };
  }
  if (signal?.aborted) return { kind: "blocked", message: "Stopped." };
  if (!matches) return { kind: "unmatched" };

  const blocked = operatorActionBlockedReason(text, "native", "live");
  if (blocked) return { kind: "blocked", message: blocked };
  if (signal?.aborted) return { kind: "blocked", message: "Stopped." };

  try {
    const result = await tauriInvoke<string | null>("native_op_try", {
      goal: text,
      ownerToken: ownerToken ?? null,
    });
    return result
      ? { kind: "done", message: result }
      : { kind: "failed", message: "I matched that as a local desktop action, but it didn't complete." };
  } catch (err) {
    return { kind: "failed", message: nativeFailureMessage(err) };
  }
}

/**
 * Used ONLY as a last resort before the Codex handoff - the Realtime lane never needs this
 * because the model calls `open_app` with a clean name, but the local lane has no tool-caller,
 * so a minimal verb strip is the honest way to reach the same primitive.
 */
const OPEN_VERB_RE =
  /^(?:please\s+)?(?:can you\s+|could you\s+|would you\s+)?(?:open|launch|start|run|bring)\s+(?:up\s+)?(.+)$/i;

/**
 * Give the REAL app launcher a shot before falling back to the Codex prompt-paste.
 * `desktop_open_app` resolves any installed app (Start Menu / App Paths / PATH),
 * so this is what makes "open the browser" and "open Blender" work in the local
 * lane instead of dead-ending in "switch execution mode to Live".
 *
 * Returns the spoken confirmation on success, or null to continue to the handoff.
 */
async function tryRealOpen(text: string, signal?: AbortSignal): Promise<string | null> {
  if (!inTauri() || signal?.aborted) return null;
  const match = OPEN_VERB_RE.exec(text.trim());
  if (!match) return null;
  const target = match[1].trim().replace(/[.!?,;]+$/, "");
  if (!target) return null;
  if (operatorActionBlockedReason(text, "native", "live")) return null;
  try {
    return await tauriInvoke<string>("desktop_open_app", { name: target });
  } catch {
    // No such app - let the visible-operator handoff have its turn.
    return null;
  }
}

async function handoffVisibleOperator(
  text: string,
  signal?: AbortSignal,
  ownerToken?: string,
): Promise<{ ok: boolean; message: string }> {
  if (signal?.aborted) return { ok: false, message: "Stopped." };
  const blocked = operatorActionBlockedReason(text, "visible", "live");
  if (blocked) {
    // HYBRID ends here on purpose: only Live mode hands the screen to Codex.
    return {
      ok: false,
      message: currentExecMode() === "live" ? blocked : `I couldn't do that with my own tools. ${blocked}`,
    };
  }
  if (signal?.aborted) return { ok: false, message: "Stopped." };
  try {
    const output = await tauriInvoke<string>("computer_use_operate", {
      goal: text,
      skipNative: true,
      ownerToken: ownerToken ?? null,
      origin: "live" satisfies ActionOrigin,
    });
    if (signal?.aborted) return { ok: false, message: "Stopped." };
    const message = output.toLowerCase().includes("cancellable handoff")
      ? "Codex is open with the scoped prompt ready. Submit it there when you want the visible run to start."
      : output;
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: `Visible Computer Use could not start: ${String(err).slice(0, 100)}` };
  }
}

// ── Direct-input rung ────────────────────────────────────────────────────────

async function runLocalOp(
  op: Exclude<
    ReturnType<typeof classifyLocal>,
    { kind: "unknown" } | { kind: "halt" } | { kind: "todo" } | { kind: "unattended" }
  >,
): Promise<{ ok: boolean; message: string }> {
  switch (op.kind) {
    case "type": {
      const gate = directInputGate(op.text);
      if (gate) return { ok: false, message: gate };
      const r = await hybridType(op.text);
      return { ok: r.ok, message: r.message };
    }
    case "press": {
      // That IS the authorization - there is no second confirmation to collect.
      const gate = directInputGate("");
      if (gate) return { ok: false, message: gate };
      const r = await hybridPress(op.key, "live");
      return { ok: r.ok, message: r.message };
    }
    case "scroll": {
      const gate = directInputGate("");
      if (gate) return { ok: false, message: gate };
      const r = await hybridScroll(op.direction, op.amount);
      return { ok: r.ok, message: r.message };
    }
  }
}

// ── Brain classify rung ──────────────────────────────────────────────────────

/** Hard ceiling on the classify round-trip. A degraded/cold brain must NEVER hang
 *  the fast lane - if the NIM call doesn't answer within this budget we treat it as
 *  a misfire and fall back to the honest answer path (never the deep loop). */
const BRAIN_CLASSIFY_TIMEOUT_MS = 6000;

/** Resolve to `null` if `p` hasn't settled within `ms` - the timeout is a misfire,
 *  not a rejection, so the caller's `!cls` fallback handles it uniformly. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, ms);
    p.then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          resolve(v);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          resolve(null);
        }
      },
    );
  });
}

/**
 * Ask the fast NVIDIA brain to bucket an unmatched utterance. It bypasses the
 * persisted planning selection so classification stays low-latency and does not
 * consume the shared OpenAI wallet. Wrapped in a hard 6s
 * timeout (withTimeout) so a degraded brain can't stall the lane. Returns null on
 * any failure OR timeout - the caller then answers honestly, never escalates.
 */
async function brainClassify(utterance: string): Promise<ReturnType<typeof parseClassify>> {
  if (!inTauri()) return null;
  const prompt = classifyPrompt(utterance);
  // Two free rails RACE; the first parseable answer wins. Measured 2026-09-17 on the
  // installed app: NVIDIA NIM took 0.8 s, 3.5 s and 25.5 s for three utterances against a
  // 6 s budget, while Groq (voice_stt.rs groq_classify) answered the same prompt in
  // 144-219 ms. Keeping NIM in the race means an expired Groq model id (or a missing key)
  // degrades to the old behaviour instead of breaking the lane.
  const nim = tauriInvoke<string>("brain_chat", {
    message: prompt,
    context: null,
    model: "nvidia/nemotron-3.5-lightning-30b-a3b",
    provider: "nvidia",
  }).then(parseClassify);
  const groq = tauriInvoke<string>("groq_classify", { prompt }).then(parseClassify);
  // First PARSEABLE answer wins; null only when both rails fail.
  const first = new Promise<ReturnType<typeof parseClassify>>((resolve) => {
    let pending = 2;
    for (const rail of [groq, nim]) {
      rail.then(
        (c) => {
          if (c) resolve(c);
          else if (--pending === 0) resolve(null);
        },
        () => {
          if (--pending === 0) resolve(null);
        },
      );
    }
  });
  return withTimeout(first, BRAIN_CLASSIFY_TIMEOUT_MS);
}

// ── The Atlas quick-answer path (shared memory, NO deep loop) ─────────────────

/**
 * Answer an utterance through the SAME ask() path Atlas's quick-ask panel and the
 * Mission input use - so the voice lane answers from Praxis's shared memory/context,
 * never a bare echo. ask() assembles the live context (see usePraxisStore.ask →
 * gatherAskContext) and calls brain_chat once; we speak the reply here. This is the
 * conversational floor of the never-escalate guard: anything that ISN'T an explicit
 * goal verb lands here, not in orchestrate().
 *
 * Returns the spoken reply text (already said via the transport) so the caller can
 * put it in the feed. Best-effort: on any failure we speak+return a short honest line.
 */
async function answerViaAsk(utterance: string, ctx: HybridRouterContext): Promise<string> {
  try {
    const { usePraxisStore } = await import("@/store/usePraxisStore");
    // speak:false - WE own the audible reply here (single voice), so ask() must not
    // also fire its own speak() and double-talk over the transport.
    // transcript "caller": this router's feed item is the record of the exchange
    // (mirrorVoiceTurn), so ask() must not write a second, "typed" copy of it.
    const res = await usePraxisStore
      .getState()
      .ask(utterance, { speak: false, signal: ctx.signal, transcript: "caller" });
    if (ctx.signal?.aborted) return "Stopped.";
    const reply = res?.text?.trim() || "I'm not sure about that one.";
    await ctx.transport.say(reply);
    return ctx.signal?.aborted ? "Stopped." : reply;
  } catch {
    if (ctx.signal?.aborted) return "Stopped.";
    const reply = "I couldn't reach my memory just now — try that again in a moment.";
    await ctx.transport.say(reply);
    return ctx.signal?.aborted ? "Stopped." : reply;
  }
}

// ── The escalation hand-off ──────────────────────────────────────────────────

/**
 * Hand a heavy/multi-step goal to the EXISTING orchestrate() loop as a background
 * run. Hybrid is a fast lane IN FRONT of orchestration - it never rebuilds it.
 * Fire-and-forget: the orchestrator streams its own PraxisEvents into the brain +
 * session panel; we only speak the acknowledgment and return.
 *
 * This is the SINGLE-TASK path: one named goal, the orchestrator's default
 * interactive iteration budget (≤10). See escalateUnattended() below for the
 * long-horizon "go do everything" sibling - the two are deliberately kept
 * separate rather than one function branching on a flag, so each call site's
 * intent (one task vs. the whole backlog) stays obvious at the call.
 */
let praxisOwnerSeq = 0;

/**
 * A job Atlas hands to Praxis belongs to PRAXIS, not to the voice turn that asked.
 *
 * It used to run under the voice session's owner token, and ending the session
 * (`useHybridSession.endSession` → `stopOperatorSessionRuns`) stops every owner that
 * session minted. Ctrl+T closes after ONE turn, so "build me a website" was stopped
 * at the next step boundary seconds after Atlas said it had started. A build is not a
 * visible operator touching the screen; it must outlive the conversation. HALT ALL
 * ("halt all" / "stop everything" / the breaker) still stops it, and the loop checks
 * the breaker before every iteration.
 */
export function praxisOwnerToken(kind: "build" | "unattended"): string {
  return `praxis-${kind}-${Date.now().toString(36)}-${praxisOwnerSeq++}`;
}

/** Say how a handed-off job ended, even after the voice session that started it closed. */
async function announceOutcome(result: { done: boolean; summary: string; missionId?: string; deferredUntil?: number } | null | undefined): Promise<void> {
  if (!result) return;
  let summary: string;
  if (result.deferredUntil) {
    // Every agent was out: Praxis queued the mission and will start it on its own.
    const at = new Date(result.deferredUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    summary = `Every agent is out of usage right now, so Praxis queued it and will start it at ${at} on its own. It's in Mission.`;
  } else {
    const closing = (await loadMissionThread()).filter((m) => m.missionId === result.missionId && (m.kind === "result" || m.kind === "failure")).pop();
    const done = closing ? closing.kind === "result" : result.done;
    summary = closing?.text?.trim()
      ? `Praxis says: ${speakable(closing.text)}`
      : done
        ? "Praxis says it's done - it's in your Inbox and Mission."
        : "Praxis says it didn't finish - the reason and what's left are in Mission.";
  }
  try {
    const { mirrorJobOutcome } = await import("./atlasChatBridge");
    mirrorJobOutcome(summary, result.done);
  } catch {
    /* the thread is a record, never a gate on the announcement */
  }
  try {
    const { usePraxisStore } = await import("@/store/usePraxisStore");
    usePraxisStore.getState().notify(summary.slice(0, 240));
  } catch {
    /* no store in this surface */
  }
  try {
    const { speak } = await import("./speak");
    // Paths are for the screen, not for the ear.
    const spoken = summary.replace(/[A-Za-z]:\\[^\s,;]+/g, "its folder").replace(/\s{2,}/g, " ");
    speak(spoken.slice(0, 480));
  } catch {
    /* speech unavailable - the notification carries it */
  }
}

function escalate(goal: string, _sessionOwner?: string, signal?: AbortSignal, brief = goal): void {
  if (signal?.aborted) return;
  const missionId = newMissionId();
  const ownerToken = praxisOwnerToken("build");
  // No upstream session signal either: a barge-in on the NEXT utterance must not
  // cancel a build that is already Praxis's job.
  void startOwnedOrchestration(ownerToken, undefined, async (ownedSignal) => {
    if (ownedSignal.aborted) throw new Error("Owned orchestration stopped before admission.");
    await postMissionMsg({ missionId, from: "zach", kind: "mission", title: missionTitle(goal), text: goal });
    await postMissionMsg({ missionId, from: "atlas", kind: "brief", text: brief.trim() || goal });
    const prompt = brief.trim() || goal;
    const { tryOrchestrate } = await import("@/orchestrator/respond");
    if (ownedSignal.aborted) throw new Error("Owned orchestration stopped before admission.");
    return tryOrchestrate(prompt, {
      missionId, missionOpened: true, intent: goal,
      signal: ownedSignal,
      ownerToken,
      ownerRunRegistered: true,
    }) ?? import("@/orchestrator/orchestrator").then(({ orchestrate }) =>
      orchestrate(prompt, {
        missionId, missionOpened: true, intent: goal,
        signal: ownedSignal,
        ownerToken,
        ownerRunRegistered: true,
      }),
    );
  })
    .then((result) => announceOutcome(result))
    .catch((err) => console.error("[hybrid] escalate failed:", err));
}

/**
 * Hand a LONG-HORIZON multi-task goal to orchestrate({unattended:true}) - the "go do everything"
 * family (see UNATTENDED_RE in hybridClassify.ts). Scope is pulled from the Command Center to-do
 * store + intent ledger "Open now" by startUnattendedRun() (src/orchestrator/unattended.ts), NOT
 * from the spoken utterance - the owner doesn't name tasks, he names the intent to clear the backlog.
 * `focusNote` carries an optional spoken focus ("focus on Praxis tonight") through from the
 * brain classify's payload. Fire-and-forget, same shape as escalate().
 */
function escalateUnattended(
  focusNote: string | undefined,
  ownerToken: string | undefined,
  signal: AbortSignal | undefined,
  say: (text: string) => void | Promise<void>,
): void {
  if (signal?.aborted) return;
  void ownerToken; // session owner deliberately NOT used - see praxisOwnerToken()
  void import("@/orchestrator/unattended")
    .then(({ startUnattendedRun, unattendedBlockedReason }) => {
      if (signal?.aborted) return null;
      // Same class as escalate(): an overnight run must outlive the one-turn voice
      // session that started it. HALT ALL stops it.
      const run = startUnattendedRun(focusNote, praxisOwnerToken("unattended"));
      // The dial declined. SAY it - this is the one surface the trust level is
      // supposed to stop, so the owner needs to hear which detent stopped it and what
      // to move it to. A fire-and-forget that quietly does nothing is the failure
      // mode this whole change exists to remove.
      if (!run) {
        const why = unattendedBlockedReason();
        if (why) void say(why);
      }
      return run;
    })
    .catch((err) => console.error("[hybrid] unattended escalate failed:", err));
}

/**
 * Atlas CALLED `escalate` - the decision to hand this job to Praxis is already made.
 *
 * The tool path used to replay the goal through the whole ladder, which ends in a 6-second
 * NVIDIA re-classification. Only the gates that must still apply run here: HALT, and the
 * Sovereign gate for credentialed actions (the caller sends those through the full ladder).
 */
export async function routeEscalation(goal: string, ctx: HybridRouterContext, brief?: string): Promise<HybridFeedItem> {
  const transcript = goal.trim();
  const item = (resolution: HybridResolution, detail: string): HybridFeedItem => {
    const out: HybridFeedItem = { id: feedId(), transcript, resolution, detail, ts: Date.now() };
    if (resolution !== "halt") ctx.emit(out);
    return out;
  };
  if (!transcript) return item("ignored", "");
  if (ctx.signal?.aborted) return item("halt", "Stopped.");
  if (isHalted()) {
    const msg = "Everything is halted right now. Say 'resume all' or clear the HALT breaker first.";
    await ctx.transport.say(msg);
    return item("blocked", msg);
  }
  escalate(transcript, ctx.ownerToken, ctx.signal, brief);
  const ack = "I handed that to Praxis. You can follow the work in Mission.";
  await ctx.transport.say(ack);
  return item("escalated", `${ack} (${transcript.slice(0, 60)}${transcript.length > 60 ? "…" : ""})`);
}

// ── The router ───────────────────────────────────────────────────────────────

/**
 * Route ONE finalized utterance through the fast ladder. Speaks confirmations via
 * the transport and emits a feed item. Never throws - every rung is guarded.
 *
 * `depth` guards the QUICK_ACTION re-entry: a brain-normalized command re-runs
 * through the ladder ONCE (depth 1) and then, if still unmatched, is spoken as an
 * answer rather than looping.
 */
export async function routeHybridUtterance(
  raw: string,
  ctx: HybridRouterContext,
  depth = 0,
): Promise<HybridFeedItem> {
  const transcript = raw.trim();
  const stopped = (): boolean => Boolean(ctx.signal?.aborted);
  const stoppedItem = (): HybridFeedItem => ({
    id: feedId(),
    transcript,
    resolution: "halt",
    detail: "Stopped.",
    ts: Date.now(),
  });
  const done = (resolution: HybridResolution, detail: string, displayMarkdown?: string): HybridFeedItem => {
    if (stopped() && resolution !== "halt") return stoppedItem();
    const item: HybridFeedItem = { id: feedId(), transcript, resolution, detail, displayMarkdown, ts: Date.now() };
    ctx.emit(item);
    return item;
  };

  if (!transcript) return done("ignored", "");
  if (ctx.signal?.aborted) {
    return { id: feedId(), transcript, resolution: "halt", detail: "Stopped.", ts: Date.now() };
  }

  // ── LOCAL pre-classify (zero latency) ──────────────────────────────────────
  const local = classifyLocal(transcript);
  const cmd = parseCommand(transcript, areaRefs());

  // HALT - abort in-flight work. Barge-in already stopped speech in the hook; this
  // aborts a running action/escalated run via the injected onHalt (which also
  // cancels an active unattended run - see useHybridSession.ts's onHalt wiring).
  if (local.kind === "halt") {
    const result = await ctx.onHalt();
    if (stopped()) return stoppedItem();
    const states = result
      ? [result.orchestration, result.unattended, result.computerUse, result.sovereign, result.native]
      : [];
    const hasUnavailable = states.includes("unavailable");
    const message = states.includes("requested") && hasUnavailable
      ? "Stop requested where available; I couldn't confirm every lane."
      : states.includes("requested")
        ? "Stop requested."
      : states.length > 0 && states.every((state) => state === "idle")
        ? "Nothing active to stop."
        : "I couldn't confirm every stop lane.";
    return done("halt", message);
  }

  // HALT/RESUME must remain reachable while the breaker is thrown.
  if (cmd?.intent.kind === "halt") {
    const res = await executeVoiceCommand(cmd, ctx.signal, ctx.ownerToken);
    if (stopped()) return stoppedItem();
    if (res.reply) await ctx.transport.say(res.reply);
    if (stopped()) return stoppedItem();
    return done("command", res.reply || cmd.say || "Done.");
  }

  if (isHalted()) {
    const msg = "Everything is halted right now. Say 'resume all' or clear the HALT breaker first.";
    await ctx.transport.say(msg);
    if (stopped()) return stoppedItem();
    return done("blocked", msg);
  }

  // Refusal is a universal zero-mutation preflight. It must beat unattended,
  // Sovereign, native, visible-operator, and classifier rungs.
  if (cmd?.intent.kind === "refuse") {
    const res = await executeVoiceCommand(cmd, ctx.signal, ctx.ownerToken);
    if (stopped()) return stoppedItem();
    const message = res.reply || cmd.say || "That window command is not safe to run.";
    await ctx.transport.say(message);
    if (stopped()) return stoppedItem();
    return done("blocked", message);
  }

  // "Open/search in Edge" still takes the native browser path because it does not match this
  // exact request shape.
  const webQuery = explicitWebSearchQuery(transcript);
  if (webQuery) {
    try {
      const answer = await searchWebAnswer(webQuery, ctx.signal);
      if (stopped()) return stoppedItem();
      const spoken = webSearchSpokenBrief(answer);
      await ctx.transport.say(spoken);
      if (stopped()) return stoppedItem();
      return done("answer", spoken, answer.markdown);
    } catch (error) {
      if (stopped()) return stoppedItem();
      const detail = error instanceof Error ? error.message : String(error);
      const message = detail || "I couldn't search the web right now.";
      await ctx.transport.say(message);
      if (stopped()) return stoppedItem();
      return done("blocked", message);
    }
  }

  // UNATTENDED - "go do everything" family, matched BEFORE grammar/native-op/
  // direct-input so a canonical phrase always reaches the long-horizon loop
  // rather than being swallowed by, say, parseCommand's generic fallback. Scope
  // comes from the to-do store + memory ledger, not the utterance - see
  // escalateUnattended()/buildUnattendedGoal() (src/orchestrator/unattended.ts).
  if (local.kind === "unattended") {
    escalateUnattended(local.note, ctx.ownerToken, ctx.signal, (t) => ctx.transport.say(t));
    const ack = "Starting an unattended run — I'll work through everything and report back.";
    await ctx.transport.say(ack);
    if (stopped()) return stoppedItem();
    return done("unattended", ack);
  }

  // ── (a) existing voice grammar ─────────────────────────────────────────────
  // parseCommand resolves EVERYTHING to a verb (unmatched → {kind:"ask"}), so we
  // only treat it as a real command when it's NOT the ask fallback - otherwise the
  // native/direct-input/brain rungs below should get their shot.
  if (cmd && cmd.intent.kind !== "ask") {
    if (voiceCommandNeedsDesktop(cmd.intent.kind)) {
      const blocked = operatorActionBlockedReason(transcript, "native", "live");
      if (blocked) {
        await ctx.transport.say(blocked);
        return done("blocked", blocked);
      }
    }
    try {
      const res = await executeVoiceCommand(cmd, ctx.signal, ctx.ownerToken);
      if (stopped()) return stoppedItem();
      if (res.reply) await ctx.transport.say(res.reply);
      if (stopped()) return stoppedItem();
      return done("command", res.reply || cmd.say || "Done.");
    } catch (err) {
      return done("command", `Command failed: ${String(err).slice(0, 80)}`);
    }
  }

  // ── (b) native op (open/url/search/focus/media) ────────────────────────────
  const native = await tryNativeOp(transcript, ctx.signal, ctx.ownerToken);
  if (ctx.signal?.aborted) {
    return { id: feedId(), transcript, resolution: "halt", detail: "Stopped.", ts: Date.now() };
  }
  if (native.kind === "blocked") {
    await ctx.transport.say(native.message);
    if (stopped()) return stoppedItem();
    return done("blocked", native.message);
  }
  if (native.kind === "done") {
    await ctx.transport.say(native.message);
    if (stopped()) return stoppedItem();
    return done("action", native.message);
  }
  if (native.kind === "failed") {
    await ctx.transport.say(native.message);
    if (stopped()) return stoppedItem();
    return done("blocked", native.message);
  }

  // ── (b2) real app launcher - anything the alias table didn't know ──────────
  // The alias table covers ~16 names; this resolves ANY installed app. Placed
  // after the table (so known apps stay instant) and before the classifier (so
  // "open Blender" never needs a brain round-trip to work).
  const openedDirect = await tryRealOpen(transcript, ctx.signal);
  if (ctx.signal?.aborted) {
    return { id: feedId(), transcript, resolution: "halt", detail: "Stopped.", ts: Date.now() };
  }
  if (openedDirect) {
    await ctx.transport.say(openedDirect);
    if (stopped()) return stoppedItem();
    return done("action", openedDirect);
  }

  if (sensitiveGoal(transcript) && !/\?\s*$/.test(transcript)) {
    const decision = routeSovereign(transcript, { speak: !ctx.typed, ownerToken: ctx.ownerToken, origin: "live" });
    if (decision.kind === "refused") {
      await ctx.transport.say(decision.message);
      if (stopped()) return stoppedItem();
      return done("blocked", decision.message);
    }
    if (decision.kind === "sovereign") {
      // Runs in the background; we don't block the voice lane on it.
      return done("escalated", "On it — driving the browser now.");
    }
  }

  // Typed desktop task the instant rungs couldn't finish: the operator loop takes it from here.
  // (A build goal never reaches this path.)
  if (ctx.typed) return done("ignored", "");

  // ── (c) direct-input primitive (type/press/scroll) ─────────────────────────
  if (local.kind === "type" || local.kind === "press" || local.kind === "scroll") {
    const r = await runLocalOp(local);
    if (stopped()) return stoppedItem();
    await ctx.transport.say(r.message);
    if (stopped()) return stoppedItem();
    return done(r.ok ? "action" : "blocked", r.message);
  }

  // TODO detected locally - capture without a brain round-trip.
  if (local.kind === "todo") {
    await captureTodo(local.text);
    if (stopped()) return stoppedItem();
    const detail = `Added to your to-do: “${local.text}”.`;
    await ctx.transport.say("Added that to your to-do list.");
    if (stopped()) return stoppedItem();
    return done("todo", detail);
  }

  if (isImperativeBuildGoal(transcript)) {
    escalate(transcript, ctx.ownerToken, ctx.signal);
    const ack = "I handed that to Praxis. You can follow the work in Mission.";
    await ctx.transport.say(ack);
    return done("escalated", `${ack} (${transcript.slice(0, 60)}${transcript.length > 60 ? "…" : ""})`);
  }

  // ── (d) brain classify - the fallback intelligence ─────────────────────────
  const cls = await brainClassify(transcript);
  if (ctx.signal?.aborted) {
    return { id: feedId(), transcript, resolution: "halt", detail: "Stopped.", ts: Date.now() };
  }

  if (!cls) {
    // Brain classify misfired or TIMED OUT (6s guard). This must NEVER fall into the
    // deep orchestrate() loop. Two honest paths:
    //  • Not in the desktop shell → there's no brain to reach, say so.
    //  • In-app but the classifier was degraded → still ANSWER the utterance via the
    //    shared ask() path (same memory Praxis uses). If it reads like a real build
    //    goal, tell the owner to say it as a Mission dump rather than silently building.
    if (!inTauri()) {
      const msg = "Voice needs the Praxis desktop app to reach the brain.";
      await ctx.transport.say(msg);
      return done("ignored", msg);
    }
    if (GOAL_RE.test(transcript) || UNATTENDED_RE.test(transcript)) {
      const msg =
        "My fast brain's too slow right now to be sure that's a build — type it into the brain-dump box and Praxis will take it from there.";
      await ctx.transport.say(msg);
      return done("answer", msg);
    }
    const reply = await answerViaAsk(transcript, ctx);
    return done("answer", reply);
  }

  switch (cls.class) {
    case "TODO": {
      const taskText = cls.payload || transcript;
      await captureTodo(taskText);
      await ctx.transport.say("Noted — it's on your to-do list.");
      return done("todo", `Added to your to-do: “${taskText}”.`);
    }
    case "ANSWER": {
      // Answer from Praxis's SHARED memory, not the tiny classifier's context-free
      // guess: re-ask through the same ask() path Atlas's panel + Mission use, so the
      // voice lane and Praxis answer from the same knowledge. (The classifier's inline
      // payload is produced with no live context - good enough to route, not to speak.)
      const reply = await answerViaAsk(transcript, ctx);
      return done("answer", reply);
    }
    case "QUICK_ACTION": {
      // Re-route the brain-normalized command through the ladder ONCE more so the
      // native/direct-input rungs get a clean, well-formed command to match.
      const normalized = cls.payload || transcript;
      if (depth === 0 && normalized && normalized.toLowerCase() !== transcript.toLowerCase()) {
        return routeHybridUtterance(normalized, ctx, depth + 1);
      }
      // Still unmatched after normalization - try the native op directly, else say so.
      const n2 = await tryNativeOp(normalized, ctx.signal, ctx.ownerToken);
      if (ctx.signal?.aborted) {
        return { id: feedId(), transcript, resolution: "halt", detail: "Stopped.", ts: Date.now() };
      }
      if (n2.kind === "blocked") {
        await ctx.transport.say(n2.message);
        if (stopped()) return stoppedItem();
        return done("blocked", n2.message);
      }
      if (n2.kind === "done") {
        await ctx.transport.say(n2.message);
        if (stopped()) return stoppedItem();
        return done("action", n2.message);
      }
      if (n2.kind === "failed") {
        await ctx.transport.say(n2.message);
        if (stopped()) return stoppedItem();
        return done("blocked", n2.message);
      }
      const opened = await tryRealOpen(normalized, ctx.signal);
      if (opened) {
        await ctx.transport.say(opened);
        if (stopped()) return stoppedItem();
        return done("action", opened);
      }
      const visible = await handoffVisibleOperator(normalized, ctx.signal, ctx.ownerToken);
      if (stopped()) return stoppedItem();
      await ctx.transport.say(visible.message);
      if (stopped()) return stoppedItem();
      return done(visible.ok ? "escalated" : "blocked", visible.message);
    }
    case "UNATTENDED": {
      // Brain-classified paraphrase of "go do everything" (the local UNATTENDED_RE
      // fast match in hybridClassify.ts didn't catch this phrasing). A 500-iteration
      // overnight run is the heaviest thing the fast lane can trigger, so it too is
      // gated by the never-escalate guard: only fire when the raw utterance genuinely
      // reads as the "do everything" family (UNATTENDED_RE) or a build goal (GOAL_RE).
      // A classifier misfire on ordinary conversation must NEVER launch the backlog run.
      if (!UNATTENDED_RE.test(transcript) && !GOAL_RE.test(transcript)) {
        const reply = await answerViaAsk(transcript, ctx);
        return done("answer", reply);
      }
      // Same path as the local match: scope comes from the to-do/ledger, not the utterance.
      const focusNote = cls.payload || undefined;
      escalateUnattended(focusNote, ctx.ownerToken, ctx.signal, (t) => ctx.transport.say(t));
      const ack = "Starting an unattended run — I'll work through everything and report back.";
      await ctx.transport.say(ack);
      if (stopped()) return stoppedItem();
      return done("unattended", ack);
    }
    case "ESCALATE":
    default: {
      // NEVER-ESCALATE GUARD. The fast lane hands to the multi-minute orchestrate() loop ONLY
      // for an EXPLICIT goal - an utterance carrying a real build verb (GOAL_RE) or the "do
      // everything" family (UNATTENDED_RE). The tiny classifier over-fires ESCALATE on ordinary
      // conversation ("how's the build going?", "what should I do next?"), and a
      // timed-out/degraded brain could too - so we gate on the SAME goal test the Mission input
      // uses, checked against the raw utterance AND the classifier's normalized goal. If neither
      // reads as a goal, this is conversation: answer via the shared ask() path, never the deep
      // loop. The classifier's payload is a one-line summary: it drops exactly the parts that
      // matter ("using Vega, Quill and Forge", "then open it and maximize it").
      const goal = GOAL_RE.test(transcript) || UNATTENDED_RE.test(transcript) ? transcript : cls.payload || transcript;
      const isRealGoal =
        GOAL_RE.test(transcript) ||
        UNATTENDED_RE.test(transcript) ||
        GOAL_RE.test(goal) ||
        UNATTENDED_RE.test(goal);
      if (!isRealGoal) {
        const reply = await answerViaAsk(transcript, ctx);
        return done("answer", reply);
      }
      escalate(goal, ctx.ownerToken, ctx.signal);
      const ack = "I handed that to Praxis. You can follow the work in Mission.";
      await ctx.transport.say(ack);
      return done("escalated", `${ack} (${goal.slice(0, 60)}${goal.length > 60 ? "…" : ""})`);
    }
  }
}
