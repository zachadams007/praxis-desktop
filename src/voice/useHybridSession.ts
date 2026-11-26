/**
 * While a session is LIVE, the mic stays open for the session's whole lifetime: speech is
 * segmented on silence into utterances, each finalized utterance is routed through the fast
 * router (hybridRouter), and the loop immediately re-arms for the next thing the owner says. Fully
 * interruptible.
 *
 * Transport split (see hybridTransport.ts):
 *   • V1 (LocalStackTransport): this hook OWNS speech input. In the packaged app it
 *     uses continuous getUserMedia + a Web-Audio VAD to segment utterances, then
 *     the Rust `transcribe_audio` (Groq Whisper) command per segment. In a dev
 *     browser it uses the Web Speech SpeechRecognition continuous stream (real
 *     interim). Either way, a finalized utterance → routeHybridUtterance.
 *   • A future speech-to-speech transport (ownsInput=true) would fold STT into
 *     itself; this hook would then just relay transport events. The router + UI are
 *     untouched by that swap - the whole point of the transport seam.
 *
 * Barge-in: while the transport is speaking, the FIRST detected speech cancels it
 * (transport.stopSpeaking) and the new utterance is captured + routed.
 *
 * Teardown guard: the recognizer/stream self-heals - an onend/onerror re-inits
 * unless the session is ending (mirrors the guards in useVoice / useVoiceCapture).
 *
 *   • mode "continuous" (CONVERSE, Ctrl+T→Space): unchanged.
 *   • mode "once" (Ctrl+T, hold T, V, Talk): the mic records locally from the instant
 *     of the press, so nothing is lost while Realtime connects; the words go into the
 *     SAME Realtime session as text (same instructions, tools, voice, Atlas panel,
 *     pill), and the session ends when that turn has played out. If Atlas answers
 *     with a question it stays for one reply. When Realtime is unavailable the same
 *     words go through the same local router CONVERSE falls back to.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createHybridTransport, type HybridTransport } from "./hybridTransport";
import { routeHybridUtterance, type HybridFeedItem } from "./hybridRouter";
import { mirrorRealtimeTurn, mirrorVoiceNotice, mirrorVoiceTurn } from "./atlasChatBridge";
import { canRecognize } from "./speak";
import {
  OPENAI_CREDIT_EXHAUSTED,
  RealtimeTransport,
  isCreditExhausted,
  refreshRealtimeReady,
  realtimeAvailable,
} from "./realtimeTransport";
import { LocalStackTransport } from "./hybridTransport";
import { announceLocalFallback, FALLBACK_ANNOUNCEMENT } from "./fallbackAnnouncement";
import { publishMicStream } from "./micLevel";
import { publishPraxisStatus } from "@/shared/praxisStatus";
import { usePraxisStore } from "@/store/usePraxisStore";
import {
  createOperatorOwnerToken,
  createOperatorTurnEpoch,
  getUnresolvedOperatorOwners,
  registerAsyncCleanup,
  SerializedOperatorStopQueue,
  stopAllOperatorRuns,
  stopOperatorOwners,
  stopOperatorSessionRuns,
  waitForCurrentOperatorTurn,
} from "./stopOperatorRuns";

const inTauri = (): boolean =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

// VAD tuning (Groq/segmented path). Levels are RMS of the analyser time-domain data.
const VAD_SPEECH_THRESHOLD = 0.018; // above → speech present
const VAD_SILENCE_MS = 2500; // allow natural thinking pauses before finalizing
const VAD_MIN_UTTERANCE_MS = 350; // ignore sub-350ms blips (clicks, coughs)
const VAD_MAX_UTTERANCE_MS = 60000; // safety cap; long instructions should not auto-send early
const VAD_POLL_MS = 60; // analyser poll cadence

// Single-turn capture (Ctrl+T). Shorter than the conversation's 2.5s pause: one
// sentence then a beat of quiet is the whole request, and Ctrl+T or releasing T
// sends immediately without waiting for it.
const ONCE_SILENCE_MS = 1200;
const ONCE_NO_SPEECH_MS = 8000; // pressed and never spoke: close quietly
const ONCE_MAX_MS = 60000;
/** Long enough to read a one-line notice in the pill before a single turn closes. */
const ONCE_NOTICE_MS = 1600;

// Hard ceiling on the realtime connect (mint + getUserMedia + SDP exchange + OpenAI's
// session.update acknowledgement). If the handshake stalls past this, we abort and fall
// back to local rather than hang the mic.
// 8 s was too tight: on 2026-09-16 the ephemeral-key mint ALONE measured 0.9 s and then
// 6.5 s on the installed app, and two real voice turns in a row timed out before
// `mint.ready` - Realtime never got a chance, every turn fell to the local lane. The
// local lane still answers and still hands builds to Praxis, so a longer wait only
// delays the fallback in the failure case.
const CONNECT_TIMEOUT_MS = 15000;

/** Reject a promise if it doesn't settle within `ms`. Used to bound rt.connect(). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      },
    );
  });
}

export type SessionLiveState = "listening" | "hearing" | "transcribing" | "acting" | "speaking";

/** "once" = one Ctrl+T turn; "continuous" = a CONVERSE conversation. */
export type VoiceSessionMode = "once" | "continuous";

export interface HybridSessionOptions {
  mode?: VoiceSessionMode;
  /**
   * Bumped by the owner for "that's everything": Ctrl+T pressed again or T released.
   * While the owner is still talking it sends at once; before he has said anything it
   * cancels; once Atlas is working or answering it stops the turn.
   */
  sendNowToken?: number;
  /** A single-turn session is finished (answered, cancelled, or heard nothing). */
  onOnceDone?: () => void;
  /** T is held down: a pause mid-sentence must not send early. */
  holding?: boolean;
  /** A single turn whose words were captured elsewhere: no microphone is opened. */
  initialText?: string;
}

/**
 * A silent audio track for a Realtime session that must never hear the microphone
 * (a single turn whose words arrived as text). Built from an AudioContext, so no
 * microphone permission is touched and the Windows mic indicator stays off.
 */
function silentInputTrack(): { track: MediaStreamTrack; close: () => void } | null {
  try {
    const Ctx =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const track = ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
    if (!track) {
      void ctx.close().catch(() => {});
      return null;
    }
    return { track, close: () => void ctx.close().catch(() => {}) };
  } catch {
    return null;
  }
}

/**
 * Put the empty-wallet sentence in the Atlas panel. At most once per recheck window:
 * the pill says it on every press, but the chat is a transcript, and the same line
 * after every Ctrl+T would bury the conversation it belongs to.
 */
let lastCreditNoticeAt = 0;
function announceCreditRefusal(now = Date.now()): void {
  if (lastCreditNoticeAt > 0 && now - lastCreditNoticeAt < 5 * 60 * 1000) return;
  lastCreditNoticeAt = now;
  mirrorVoiceNotice(OPENAI_CREDIT_EXHAUSTED);
}

function micErrorText(err: unknown): string {
  const msg = String(err);
  if (msg.includes("NotAllowed") || msg.includes("Permission")) return "Mic permission denied.";
  if (msg.includes("NotFound") || msg.includes("Devices")) return "No microphone found.";
  return "Couldn't open the microphone.";
}

/** Resolve once the transport has stopped talking (or after a safety cap). */
function waitForQuiet(transport: HybridTransport, capMs = 60_000): Promise<void> {
  if (!transport.isSpeaking()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let off: () => void = () => {};
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, capMs);
    off = transport.onSpeakingChange((speaking) => {
      if (!speaking) done();
    });
  });
}

export interface HybridSessionApi {
  /** Feed of finalized utterances + their resolution (newest last). */
  feed: HybridFeedItem[];
  /** Live interim line (dev: real interim; app: a "hearing you…" cue). */
  interim: string;
  /** Coarse live state for the panel's indicator. */
  liveState: SessionLiveState;
  /** True while the transport is speaking (drives tap-to-interrupt). */
  speaking: boolean;
  /** Barge-in / manual interrupt: stop speaking + abort the in-flight utterance. */
  interrupt: () => void;
  /** End this session and stop every operator run it owns. */
  endSession: () => void;
  /** Seconds since the session started (for the panel timer). */
  elapsedMs: number;
  /** Honest error/status when the mic can't run (denied / unsupported). */
  micError: string | null;
  /** Which transport is live - drives the "realtime" / "local" panel tag. */
  transportKind: "realtime" | "local";
  /** Non-blocking notice when realtime fell back to local (cap hit / setup fail). */
  transportNotice: string | null;
}

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const opts = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  for (const m of opts) if (MediaRecorder.isTypeSupported?.(m)) return m;
  return "";
}

/**
 * The continuous session loop. `active` gates the whole thing - flip it true when
 * the session locks (VoicePopup chord) and false when it ends (Ctrl+T / Esc).
 */
export function useHybridSession(
  active: boolean,
  onIdlePause?: () => void,
  options: HybridSessionOptions = {},
): HybridSessionApi {
  const { mode = "continuous", sendNowToken = 0, onOnceDone } = options;
  // Read at pause time through a ref so a new callback identity never restarts the engine.
  const onIdlePauseRef = useRef(onIdlePause);
  onIdlePauseRef.current = onIdlePause;
  const onOnceDoneRef = useRef(onOnceDone);
  onOnceDoneRef.current = onOnceDone;
  // The engine reads the mode through a ref: switching a single turn into a
  // conversation must never restart the engine (that would reconnect Realtime).
  const modeRef = useRef<VoiceSessionMode>(mode);
  // Read once: the words a session was opened with do not change during it.
  const initialTextRef = useRef(options.initialText);
  /** Set by the running engine; the mode and send-now effects below drive it. */
  const engineRef = useRef<{ upgrade?: () => void; sendNow?: () => void }>({});
  const [feed, setFeed] = useState<HybridFeedItem[]>([]);
  const [interim, setInterim] = useState("");
  const [liveState, setLiveState] = useState<SessionLiveState>("listening");
  const [speaking, setSpeaking] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [transportKind, setTransportKind] = useState<"realtime" | "local">("local");
  const [transportNotice, setTransportNotice] = useState<string | null>(null);

  // Default to the local stack; the capture effect promotes to realtime when the
  // key is present and under budget, and demotes back on any failure. Kept a ref so
  // the router/interrupt paths always see the CURRENT transport.
  const transportRef = useRef<HybridTransport>();
  if (!transportRef.current) transportRef.current = new LocalStackTransport();
  // Suppress the unused-import lint for createHybridTransport - the hook now owns the
  // realtime/local decision directly so it can wire connect() + fallback, but the
  // factory stays the documented single choke point for non-hook callers.
  void createHybridTransport;

  // Abort handle for the in-flight utterance/escalation (the router's onHalt).
  const abortRef = useRef<AbortController | null>(null);
  const pendingOwnerRef = useRef<string | null>(null);
  const detachedOwnersRef = useRef<Set<string>>(new Set());
  const turnEpochRef = useRef(createOperatorTurnEpoch());
  const activeTurnTerminalRef = useRef<Promise<void> | null>(null);
  const operatorStopQueueRef = useRef<SerializedOperatorStopQueue>();
  if (!operatorStopQueueRef.current) operatorStopQueueRef.current = new SerializedOperatorStopQueue();
  const endingRef = useRef(false);
  const startedAtRef = useRef(0);

  // ── Route a finalized utterance through the fast router ─────────────────────
  const handleUtterance = useCallback(async (text: string) => {
    const clean = text.trim();
    if (!clean || endingRef.current) return;
    const claimedEpoch = turnEpochRef.current.begin();
    const priorTurnTerminal = activeTurnTerminalRef.current ?? Promise.resolve();
    setInterim("");
    setLiveState("acting");
    const interruptedOwner = pendingOwnerRef.current ?? undefined;
    const stopTargetOwners = new Set(detachedOwnersRef.current);
    if (interruptedOwner) stopTargetOwners.add(interruptedOwner);
    abortRef.current?.abort();
    // Speech-start already requests this stop, but await it again here so a new
    // desktop action cannot race the interrupted run for the single operator slot.
    // The Rust token tombstone makes this safe even if the old run had not reached
    // backend admission when barge-in occurred.
    // enqueue(null) deliberately returns any stop already in flight. Speech-start
    // may have cleared the old route's owner ref before final STT arrives, but the
    // replacement still must wait for that scoped backend stop to settle.
    for (const retainedOwner of getUnresolvedOperatorOwners()) {
      void operatorStopQueueRef.current!.enqueue(retainedOwner).catch(() => {
        // The queue retains the exact owner and keeps admission closed.
      });
    }
    const priorStop = operatorStopQueueRef.current!.enqueue(interruptedOwner ?? null);
    if (
      !(await waitForCurrentOperatorTurn(
        turnEpochRef.current,
        claimedEpoch,
        Promise.all([priorStop, priorTurnTerminal]),
        () => endingRef.current,
      ))
    ) {
      if (!endingRef.current) setLiveState("listening");
      return;
    }
    const controller = new AbortController();
    const ownerToken = createOperatorOwnerToken("hybrid");
    let resolveTurnTerminal: () => void = () => {};
    const turnTerminal = new Promise<void>((resolve) => {
      resolveTurnTerminal = resolve;
    });
    activeTurnTerminalRef.current = turnTerminal;
    abortRef.current = controller;
    pendingOwnerRef.current = ownerToken;
    try {
      const routed = await routeHybridUtterance(clean, {
        transport: transportRef.current!,
        signal: controller.signal,
        ownerToken,
        onHalt: async () => {
          // Halt: stop speaking, abort the in-flight utterance, cancel any active
          // unattended run (the "go do everything" long-horizon loop - see
          // src/orchestrator/unattended.ts), and abort any visible operator run
          // that an earlier escalation may have started.
          transportRef.current!.stopSpeaking();
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
            for (const owner of stopTargetOwners) detachedOwnersRef.current.delete(owner);
          }
          return result;
        },
        emit: (item) => {
          setFeed((prev) => [...prev, item].slice(-40));
          mirrorVoiceTurn(item);
        },
      });
      if (!controller.signal.aborted && (routed.resolution === "escalated" || routed.resolution === "unattended")) {
        detachedOwnersRef.current.add(ownerToken);
      }
    } catch (err) {
      console.error("[hybrid] route failed:", err);
    } finally {
      if (!controller.signal.aborted && !endingRef.current) setLiveState("listening");
      if (abortRef.current === controller) abortRef.current = null;
      if (pendingOwnerRef.current === ownerToken) pendingOwnerRef.current = null;
      resolveTurnTerminal();
      if (activeTurnTerminalRef.current === turnTerminal) activeTurnTerminalRef.current = null;
    }
  }, []);

  const interrupt = useCallback(() => {
    const interruptedOwner = pendingOwnerRef.current;
    turnEpochRef.current.invalidate();
    transportRef.current!.stopSpeaking();
    abortRef.current?.abort();
    // Barge-in is scoped to the voice turn that was actually interrupted. It is
    // deliberately not HALT ALL and does not touch detached background work.
    if (interruptedOwner) {
      void operatorStopQueueRef.current!.enqueue(interruptedOwner).catch(() => {
        // Admission remains closed; the next finalized utterance retries this owner.
      });
    }
    if (!endingRef.current) setLiveState("listening");
  }, []);

  const halt = useCallback(async () => {
    interrupt();
    await stopAllOperatorRuns();
  }, [interrupt]);

  const endSession = useCallback(() => {
    endingRef.current = true;
    turnEpochRef.current.invalidate();
    transportRef.current?.stopSpeaking();

    // Snapshot without clearing ownership. Detached background runs outlive
    // their route promise, and failed teardown acknowledgement must remain retryable.
    const controller = abortRef.current;
    const pendingOwner = pendingOwnerRef.current;
    const detachedOwners = [...detachedOwnersRef.current];
    abortRef.current = null;
    const stopped = stopOperatorSessionRuns(controller, pendingOwner, detachedOwners);
    void stopped.then(
      (result) => {
        if (!result.terminal) return;
        if (pendingOwnerRef.current === pendingOwner) pendingOwnerRef.current = null;
        for (const owner of detachedOwners) detachedOwnersRef.current.delete(owner);
      },
      () => {
        // Exact owners stay in the refs + shared unresolved registry for retry.
      },
    );
  }, []);

  // Covers every exit path, including Ctrl+T in the parent and a direct unmount.
  // Resetting the guard on setup keeps React Strict Mode's setup/cleanup replay
  // from poisoning the real mounted session.
  useEffect(() => {
    if (!active) {
      endSession();
      return;
    }
    endingRef.current = false;
    return endSession;
  }, [active, endSession]);

  // The Command Center's global breaker stops this session's active turn even
  // when the halt came from another Praxis window rather than a spoken command.
  useEffect(() => {
    if (!active) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key === "praxis.halted.v1" && event.newValue === "1") void halt();
    };
    window.addEventListener("storage", onStorage);
    const disposeTauriHalt = registerAsyncCleanup(async () => {
      const { listen } = await import("@tauri-apps/api/event");
      return listen<{ halted: boolean }>("praxis://halt", (event) => {
        if (event.payload?.halted) void halt();
      });
    });
    return () => {
      window.removeEventListener("storage", onStorage);
      disposeTauriHalt();
    };
  }, [active, halt]);

  // Bumps whenever the live transport instance is swapped (local→realtime, or
  // realtime→local on fallback) so the speaking-state mirror re-binds to the new one.
  const [transportEpoch, setTransportEpoch] = useState(0);

  // ── Speaking-state mirror (drives the tap-to-interrupt affordance) ──────────
  // Re-binds on transportEpoch so it always listens to the CURRENT transport.
  useEffect(() => {
    if (!active) return;
    const off = transportRef.current!.onSpeakingChange((v) => {
      setSpeaking(v);
      if (v) setLiveState("speaking");
      else if (!endingRef.current) setLiveState((s) => (s === "speaking" ? "listening" : s));
    });
    return off;
  }, [active, transportEpoch]);

  // ── Session timer ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    const id = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  // ── Cross-window state mirror ────────────────────────────────────────────────
  // The Command Center's status rail renders the brain window's praxis://status.
  // Emit only coarse state changes - never per interim keystroke.
  useEffect(() => {
    if (!active) return;
    const state = liveState === "speaking" ? "speaking" : liveState === "acting" ? "acting" : "listening";
    void publishPraxisStatus({ state, detail: interim || transportNotice || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- interim read at emit time, not a trigger
  }, [active, liveState, transportNotice]);

  // ── Owner controls: a single turn becomes a conversation; "send it now" ─────
  useEffect(() => {
    const previous = modeRef.current;
    modeRef.current = mode;
    if (active && previous === "once" && mode === "continuous") engineRef.current.upgrade?.();
  }, [active, mode]);

  const sendNowSeenRef = useRef(sendNowToken);
  useEffect(() => {
    if (sendNowToken === sendNowSeenRef.current) return;
    sendNowSeenRef.current = sendNowToken;
    if (active) engineRef.current.sendNow?.();
  }, [active, sendNowToken]);

  const holdingRef = useRef(Boolean(options.holding));
  holdingRef.current = Boolean(options.holding);

  // ── The capture engine ──────────────────────────────────────────────────────
  // Two transports, chosen per session start:
  //   • REALTIME (ownsInput): the OpenAI GPT-Realtime-2 transport owns the mic and
  //     STT/TTS end-to-end. This hook just connects it and wires tool-feed items;
  //     the local capture loops NEVER run (so the mic is held by exactly one owner).
  //   • LOCAL: the existing Web-Speech (dev) / Groq-VAD (app) capture loops feed
  //     routeHybridUtterance, with the LocalStackTransport for TTS + barge-in.
  // A single turn ("once") records its words locally first, whichever transport
  // answers them - see the header.
  useEffect(() => {
    if (!active) return;
    endingRef.current = false;
    setFeed([]);
    setMicError(null);
    setTransportNotice(null);
    setLiveState("listening");

    const once = modeRef.current === "once";
    const initialText = once ? (initialTextRef.current ?? "").trim() : "";
    let silentInput: { track: MediaStreamTrack; close: () => void } | null = null;
    // Cleanup handle for whichever engine we start (assigned async below).
    let localCleanup: (() => void) | null = null;
    let realtime: RealtimeTransport | null = null;
    let cancelled = false;
    let localTransportSet = false;
    let continuousCaptureStarted = false;
    let fallbackCleanup: (() => void) | null = null;

    // ── single-turn state ──
    let onceStream: MediaStream | null = null;
    let onceCapture: OnceCapture | null = null;
    let onceTurnSent = false;
    let onceFollowUps = 0;
    let onceFinished = false;
    let onceLingerTimer: ReturnType<typeof setTimeout> | null = null;
    // Settles exactly once: the connected Realtime transport, or null when this
    // session answers locally. A single turn's words wait on it, bounded.
    let resolveRealtime: (rt: RealtimeTransport | null) => void = () => {};
    const realtimeOutcome = new Promise<RealtimeTransport | null>((resolve) => {
      resolveRealtime = resolve;
    });
    const realtimeWithin = () =>
      Promise.race([
        realtimeOutcome,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), CONNECT_TIMEOUT_MS + 2000)),
      ]);

    const stopOnceStream = () => {
      if (!onceStream) return;
      publishMicStream(null);
      onceStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          /* noop */
        }
      });
      onceStream = null;
    };

    /** Close a single-turn session. `linger` keeps the pill up long enough to read. */
    const finishOnce = (notice?: string, linger = Boolean(notice)) => {
      if (onceFinished || cancelled || endingRef.current) return;
      onceFinished = true;
      onceCapture?.cancel();
      onceCapture = null;
      stopOnceStream();
      if (notice) setTransportNotice(notice);
      if (linger) onceLingerTimer = setTimeout(() => onOnceDoneRef.current?.(), ONCE_NOTICE_MS);
      else onOnceDoneRef.current?.();
    };

    /** Point the session at the local stack (TTS + barge-in). Idempotent. */
    const switchToLocalTransport = (notice?: string) => {
      if (notice) setTransportNotice(notice);
      if (localTransportSet) return;
      localTransportSet = true;
      transportRef.current = new LocalStackTransport();
      setTransportKind("local");
      setTransportEpoch((n) => n + 1);
    };

    // Start the LOCAL capture engine and point transportRef at a local transport.
    const startLocal = (notice?: string, announce = false) => {
      if (cancelled || endingRef.current) return;
      switchToLocalTransport(notice);
      // A single turn already records on its own stream; there is no loop to start.
      if (modeRef.current === "once" || continuousCaptureStarted) return;
      continuousCaptureStarted = true;
      const local = transportRef.current!;
      // Clear any transient "connecting realtime…" beat left by a failed realtime
      // attempt so the panel doesn't stick on "acting" after falling back.
      if (!endingRef.current) setLiveState("listening");

      const startCapture = () => {
        if (cancelled || endingRef.current) return;
        setLiveState("listening");
        // DEV (real browser): Web Speech continuous recognition with real interim.
        if (canRecognize()) {
          localCleanup = startWebSpeechLoop({
            onInterim: setInterim,
            onFinal: (t) => void handleUtterance(t),
            onSpeechStart: () => {
              if (transportRef.current!.isSpeaking() || abortRef.current) interrupt();
              if (!endingRef.current) setLiveState("hearing");
            },
            onError: setMicError,
            isEnding: () => endingRef.current,
          });
          return;
        }

        // APP (WebView2): continuous getUserMedia + VAD segmentation → Groq per segment.
        localCleanup = startGroqSegmentLoop({
          onState: (s) => {
            if (!endingRef.current) setLiveState(s);
          },
          onInterim: setInterim,
          onFinal: (t) => void handleUtterance(t),
          onSpeechStart: () => {
            if (transportRef.current!.isSpeaking() || abortRef.current) interrupt();
          },
          onError: setMicError,
          isEnding: () => endingRef.current,
        });
      };
      if (announce) {
        setLiveState("acting");
        setTransportNotice(`${notice ?? "Realtime ended."} ${FALLBACK_ANNOUNCEMENT}`);
        fallbackCleanup = announceLocalFallback(local, startCapture);
      } else {
        startCapture();
      }
    };

    // ── A single turn's words, once transcribed ──────────────────────────────
    const handleOnceText = async (text: string) => {
      if (cancelled || endingRef.current || onceFinished) return;
      onceTurnSent = true;
      setInterim("");
      setLiveState("acting");
      // Realtime may still be connecting. The words are already safe in `text`, so
      // waiting on the connect costs latency, never the request.
      const rt = await realtimeWithin();
      if (cancelled || endingRef.current || onceFinished) return;
      if (rt && rt.isConnected()) {
        transportRef.current = rt;
        setTransportKind("realtime");
        setTransportEpoch((n) => n + 1);
        mirrorRealtimeTurn("zach", text);
        // The same session CONVERSE talks to. `onTurnIdle` closes the turn.
        if (rt.sendUserText(text)) return;
      }
      // The same local router a conversation falls back to - never the Codex ladder.
      switchToLocalTransport();
      await handleUtterance(text);
      if (cancelled || endingRef.current || onceFinished) return;
      await waitForQuiet(transportRef.current!);
      finishOnce();
    };

    const startOnce = () => {
      if (!onceStream || cancelled || endingRef.current || onceFinished) return;
      onceCapture?.cancel();
      onceTurnSent = false;
      setInterim("");
      setLiveState("listening");
      onceCapture = startOnceUtterance(onceStream, {
        onState: (s) => {
          if (!endingRef.current) setLiveState(s);
        },
        onInterim: setInterim,
        onText: (text) => {
          void handleOnceText(text);
        },
        onNothing: (why) => {
          onceCapture = null;
          if (why === "cancelled") finishOnce();
          else finishOnce(why === "silence" ? "Didn't hear anything." : "Didn't catch that.");
        },
        onError: (message) => {
          onceCapture = null;
          setMicError(message);
          finishOnce(undefined, true);
        },
        isHeld: () => holdingRef.current,
        isEnding: () => cancelled || endingRef.current || onceFinished,
      });
    };

    engineRef.current = {
      // Ctrl+T pressed again or T released: send the words, cancel an empty press,
      // or stop a turn that is already being answered.
      sendNow: () => {
        if (cancelled || endingRef.current || onceFinished || modeRef.current !== "once") return;
        if (onceCapture && !onceTurnSent) {
          onceCapture.sendNow();
          return;
        }
        interrupt();
        finishOnce();
      },
      // Ctrl+T then Space, or CONVERSE, while a single turn is open: keep the same
      // session and let it listen continuously.
      upgrade: () => {
        if (cancelled || endingRef.current || onceFinished || !once) return;
        onceCapture?.cancel();
        onceCapture = null;
        setInterim("");
        void (async () => {
          const rt = await realtimeWithin();
          if (cancelled || endingRef.current) return;
          // Realtime's cloned track keeps the microphone open on its own.
          stopOnceStream();
          if (rt && rt.isConnected()) {
            transportRef.current = rt;
            setTransportKind("realtime");
            setTransportEpoch((n) => n + 1);
            rt.setInputEnabled(true);
            setTransportNotice(null);
            setLiveState("listening");
            return;
          }
          startLocal();
        })();
      },
    };

    // Decide the transport: ask Rust if realtime is available (key + under budget),
    // then either connect it or fall through to local. The DECISION is always
    // logged + surfaced so the owner can see WHY the local stack is running whenever it
    // is - realtime never silently degrades.
    void (async () => {
      if (once && initialText) {
        // The words are already here; they wait (bounded) on the transport decision.
        void handleOnceText(initialText);
      } else if (once) {
        // Open the mic and start recording BEFORE anything slower. This is what makes
        // "press Ctrl+T and just talk" safe while Realtime is still connecting.
        try {
          onceStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
        } catch (err) {
          resolveRealtime(null);
          if (cancelled || endingRef.current) return;
          setMicError(micErrorText(err));
          finishOnce(undefined, true);
          return;
        }
        if (cancelled || endingRef.current) {
          onceStream.getTracks().forEach((track) => track.stop());
          onceStream = null;
          resolveRealtime(null);
          return;
        }
        publishMicStream(onceStream);
        startOnce();
      }

      const ready = await refreshRealtimeReady();
      if (cancelled || endingRef.current) {
        resolveRealtime(null);
        return;
      }

      // One diagnosable trail line for the realtime/local decision (visible in the
      // WebView devtools console). Never logs key material - realtime_ready never
      // returns it.
      console.info(
        `[hybrid] transport decision: ready=${ready.ready} has_key=${ready.has_key} ` +
          `spent=$${ready.spent_usd.toFixed(2)}/$${ready.cap_usd.toFixed(2)}` +
          (ready.reason ? ` reason="${ready.reason}"` : ""),
      );

      if (!realtimeAvailable()) {
        const reason =
          ready.reason ||
          (ready.has_key
            ? "Realtime is unavailable right now — using the local voice stack."
            : "No OpenAI key in the vault — using the local voice stack.");
        resolveRealtime(null);
        if (reason === OPENAI_CREDIT_EXHAUSTED) {
          announceCreditRefusal();
          startLocal(`${OPENAI_CREDIT_EXHAUSTED} Using the local voice for now.`);
        } else {
          startLocal(reason);
        }
        return;
      }

      // Realtime path. Build, wire, connect - any failure falls back to local.
      if (once) {
        // The mic is already recording; the connect happens underneath it.
        setTransportKind("realtime");
      } else {
        setLiveState("acting"); // brief "connecting" beat; flips to listening on connect
        setTransportNotice("Connecting the realtime voice…");
      }
      const rt = new RealtimeTransport();
      realtime = rt;
      rt.onFeedItem = (item) => {
        setFeed((prev) => [...prev, item].slice(-40));
        mirrorVoiceTurn(item);
      };
      rt.onTurnIdle = (lastAssistantText) => {
        if (cancelled || endingRef.current || onceFinished) return;
        if (modeRef.current !== "once" || !onceTurnSent) return;
        // Atlas asked something back: stay for the answer, once.
        if (/\?\s*$/.test(lastAssistantText) && onceFollowUps < 1 && onceStream) {
          onceFollowUps += 1;
          startOnce();
          return;
        }
        finishOnce();
      };
      rt.onSessionEnd = (reason, kind) => {
        if (cancelled || endingRef.current) return;
        realtime = null;
        if (modeRef.current === "once") {
          // A single turn has no conversation to carry on locally. Words not sent yet
          // still reach the local router (handleOnceText sees the session is gone);
          // a turn already being answered closes with the reason on screen.
          if (onceTurnSent) {
            if (kind !== "idle") mirrorVoiceNotice(reason);
            finishOnce(kind === "idle" ? undefined : reason);
          } else {
            switchToLocalTransport(reason);
          }
          return;
        }
        // A quiet stretch is not a failure. A pause now ends the session cleanly; the next chord
        // starts a fresh Realtime conversation.
        if (kind === "idle" && onIdlePauseRef.current) {
          console.info(`[hybrid] realtime paused after a quiet stretch: ${reason}`);
          setTransportNotice(reason);
          onIdlePauseRef.current();
          return;
        }
        // A real failure (cap hit / dropped / accounting): keep listening on the local
        // lane with a visible notice, never a dead mic. It speaks in the same voice.
        console.info(`[hybrid] realtime session ended → local: ${reason}`);
        startLocal(reason, true);
      };
      try {
        if (!once) {
          transportRef.current = rt;
          setTransportEpoch((n) => n + 1);
        }
        // A single turn hands Realtime a CLONE of the recording mic, muted: OpenAI
        // hears nothing until the session is upgraded to a conversation, and stopping
        // either track never ends the other.
        let inputTrack: MediaStreamTrack | undefined;
        if (once) {
          inputTrack = onceStream?.getAudioTracks()[0]?.clone();
          if (!inputTrack) {
            silentInput = silentInputTrack();
            inputTrack = silentInput?.track;
          }
        }
        // Race connect() against a hard timeout so a stalled mint/SDP exchange can
        // never hang the mic - we fall back to local instead of waiting forever.
        await withTimeout(
          rt.connect(inputTrack ? { inputTrack, inputEnabled: false } : {}),
          CONNECT_TIMEOUT_MS,
          "realtime connect timed out",
        );
        if (cancelled || endingRef.current) {
          rt.disconnect();
          resolveRealtime(null);
          return;
        }
        resolveRealtime(rt);
        if (!once) {
          setTransportKind("realtime");
          setTransportNotice(null); // clear the "connecting…" beat on success
          setLiveState("listening");
        }
        console.info("[hybrid] realtime voice ACTIVE (OpenAI GPT-Realtime speech-to-speech).");
      } catch (err) {
        // Setup failed (mic denied, SDP error, mint error, timeout) - fall back to
        // local WITH the concrete error so the owner sees exactly what broke.
        realtime = null;
        try {
          rt.disconnect();
        } catch {
          /* noop */
        }
        resolveRealtime(null);
        console.warn("[hybrid] realtime connect failed → local:", err);
        if (isCreditExhausted(err)) {
          announceCreditRefusal();
          startLocal(`${OPENAI_CREDIT_EXHAUSTED} Using the local voice for now.`);
        } else {
          startLocal(`Realtime voice couldn't connect (${String(err).slice(0, 80)}) — using the local voice.`);
        }
      }
    })();

    return () => {
      cancelled = true;
      endingRef.current = true;
      engineRef.current = {};
      if (onceLingerTimer) clearTimeout(onceLingerTimer);
      fallbackCleanup?.();
      localCleanup?.();
      onceCapture?.cancel();
      stopOnceStream();
      resolveRealtime(null);
      realtime?.disconnect();
      silentInput?.close();
    };
  }, [active, handleUtterance, interrupt]);

  // The brain's listening cue follows the session, whichever length it is.
  useEffect(() => {
    usePraxisStore.getState().setVoiceListening(active && (liveState === "listening" || liveState === "hearing"));
  }, [active, liveState]);
  useEffect(() => () => usePraxisStore.getState().setVoiceListening(false), []);

  return {
    feed,
    interim,
    liveState,
    speaking,
    interrupt,
    endSession,
    elapsedMs,
    micError,
    transportKind,
    transportNotice,
  };
}

// ── Web Speech continuous loop (dev/browser) ─────────────────────────────────

interface WebSpeechCbs {
  onInterim: (t: string) => void;
  onFinal: (t: string) => void;
  onSpeechStart: () => void;
  onError: (msg: string) => void;
  isEnding: () => boolean;
}

function startWebSpeechLoop(cbs: WebSpeechCbs): () => void {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!Ctor) {
    cbs.onError("Speech recognition unavailable.");
    return () => {};
  }
  let rec: SpeechRecognitionLike | null = new Ctor();
  rec.lang = "en-US";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onresult = (e) => {
    if (cbs.isEnding()) return;
    let interim = "";
    let final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const t = r[0]?.transcript ?? "";
      if (r.isFinal) final += t;
      else interim += t;
    }
    if (interim.trim()) {
      cbs.onSpeechStart();
      cbs.onInterim(interim.trim());
    }
    if (final.trim()) {
      cbs.onInterim("");
      cbs.onFinal(final.trim());
    }
  };
  rec.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") cbs.onError("Mic permission denied.");
    else if (e.error === "audio-capture") cbs.onError("No microphone found.");
    // transient (no-speech/network/aborted) - onend restarts
  };
  rec.onend = () => {
    if (!cbs.isEnding() && rec) {
      try {
        rec.start();
      } catch {
        /* already starting */
      }
    }
  };
  try {
    rec.start();
  } catch {
    cbs.onError("Couldn't start the recognizer.");
  }
  return () => {
    try {
      rec?.abort();
    } catch {
      /* noop */
    }
    rec = null;
  };
}

// ── One utterance (a single Ctrl+T turn) ─────────────────────────────────────

interface OnceCaptureCbs {
  onState: (s: SessionLiveState) => void;
  onInterim: (t: string) => void;
  onText: (text: string) => void;
  /** "cancelled": sent before any speech. "silence": never spoke. "empty": nothing transcribed. */
  onNothing: (why: "cancelled" | "silence" | "empty") => void;
  onError: (msg: string) => void;
  /** T is held: keep listening through pauses. */
  isHeld: () => boolean;
  isEnding: () => boolean;
}

interface OnceCapture {
  /** Send what was said so far; before any speech, cancel. */
  sendNow(): void;
  /** Stop without reporting anything. */
  cancel(): void;
}

/**
 * Record ONE utterance from an already-open stream and transcribe it.
 *
 * The recorder starts the instant this is called - not when speech is detected - so
 * the first syllable is never clipped by VAD onset or by a slow Realtime connect.
 * A level check only decides when the sentence is over: a beat of silence after
 * speech, `sendNow()`, or the length cap. The stream is the caller's; this never
 * stops its tracks.
 */
function startOnceUtterance(stream: MediaStream, cbs: OnceCaptureCbs): OnceCapture {
  const mime = pickMime();
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let finalizing = false;
  let heard = false;
  const startedAt = performance.now();
  let lastVoiceAt = startedAt;

  const report = (fn: () => void) => {
    if (!disposed && !cbs.isEnding()) fn();
  };

  const releaseMeter = () => {
    if (poll) clearInterval(poll);
    poll = null;
    void audioCtx?.close().catch(() => {});
    audioCtx = null;
    analyser = null;
  };

  const transcribe = async (blob: Blob, type: string) => {
    report(() => cbs.onState("transcribing"));
    try {
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      const { invoke } = await import("@tauri-apps/api/core");
      const text = ((await invoke<string>("transcribe_audio", { audio: bytes, mime: type })) ?? "").trim();
      report(() => (text ? cbs.onText(text) : cbs.onNothing("empty")));
    } catch (err) {
      const msg = String(err);
      report(() =>
        msg.includes("no-key")
          ? cbs.onError("Add a Groq key to enable voice (see the README).")
          : cbs.onNothing("empty"),
      );
    }
  };

  const finalize = (outcome: "send" | "cancelled" | "silence") => {
    if (finalizing || disposed) return;
    finalizing = true;
    releaseMeter();
    report(() => cbs.onInterim(""));
    const active = recorder;
    recorder = null;
    if (!active || active.state === "inactive") {
      report(() => cbs.onNothing(outcome === "send" ? "empty" : outcome));
      return;
    }
    active.onstop = () => {
      const type = active.mimeType || mime || "audio/webm";
      const blob = new Blob(chunks, { type });
      chunks = [];
      if (outcome !== "send") {
        report(() => cbs.onNothing(outcome));
        return;
      }
      if (blob.size < 1200) {
        report(() => cbs.onNothing("empty"));
        return;
      }
      void transcribe(blob, type);
    };
    try {
      active.stop();
    } catch {
      report(() => cbs.onNothing("empty"));
    }
  };

  try {
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.start();
  } catch {
    recorder = null;
    queueMicrotask(() => report(() => cbs.onError("Couldn't start recording from the microphone.")));
    return {
      sendNow() {},
      cancel() {
        disposed = true;
      },
    };
  }

  try {
    const Ctx =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    audioCtx = new Ctx();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
  } catch {
    // No level meter: Ctrl+T, releasing T and the length cap still end the turn.
    analyser = null;
  }

  const buf = new Uint8Array(1024);
  poll = setInterval(() => {
    if (disposed || finalizing) return;
    const now = performance.now();
    if (analyser) {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      if (Math.sqrt(sum / buf.length) > VAD_SPEECH_THRESHOLD) {
        if (!heard) {
          heard = true;
          report(() => {
            cbs.onState("hearing");
            cbs.onInterim("hearing you…");
          });
        }
        lastVoiceAt = now;
      }
    }
    if (now - startedAt > ONCE_MAX_MS) {
      finalize("send");
      return;
    }
    if (cbs.isHeld()) return; // push-to-talk: T decides when the sentence ends
    if (heard && now - lastVoiceAt > ONCE_SILENCE_MS) finalize("send");
    else if (!heard && analyser && now - startedAt > ONCE_NO_SPEECH_MS) finalize("silence");
  }, VAD_POLL_MS);

  return {
    sendNow() {
      if (disposed || finalizing) return;
      // Without a meter there is no way to know nothing was said - send it.
      finalize(heard || !analyser ? "send" : "cancelled");
    },
    cancel() {
      if (disposed) return;
      disposed = true;
      releaseMeter();
      const active = recorder;
      recorder = null;
      if (active && active.state !== "inactive") {
        active.onstop = null;
        try {
          active.stop();
        } catch {
          /* noop */
        }
      }
    },
  };
}

// ── Groq VAD segment loop (packaged app) ─────────────────────────────────────

interface GroqLoopCbs {
  onState: (s: SessionLiveState) => void;
  onInterim: (t: string) => void;
  onFinal: (t: string) => void;
  onSpeechStart: () => void;
  onError: (msg: string) => void;
  isEnding: () => boolean;
}

/**
 * Open ONE mic stream and run a VAD loop: detect speech, record a segment while
 * speech continues, and on ~1s of trailing silence (or the max-length cap) stop
 * the segment and transcribe it via Groq. Immediately re-arm. Self-heals on error.
 *
 * Returns a cleanup fn that stops the stream + any in-flight recorder.
 */
function startGroqSegmentLoop(cbs: GroqLoopCbs): () => void {
  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let rec: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let mime = "";

  // segment state
  let speaking = false; // are we inside an utterance right now?
  let segStart = 0;
  let lastVoiceAt = 0;
  let disposed = false;

  const stopTracks = () => {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  };

  const finalizeSegment = () => {
    if (!rec) return;
    const active = rec;
    rec = null;
    try {
      active.stop(); // fires onstop → transcribe
    } catch {
      /* already stopped */
    }
  };

  const startSegment = () => {
    if (!stream || rec) return;
    chunks = [];
    try {
      rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      rec = null;
      return;
    }
    const thisRec = rec;
    thisRec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    thisRec.onstop = () => {
      const durMs = performance.now() - segStart;
      const type = thisRec.mimeType || mime || "audio/webm";
      const blob = new Blob(chunks, { type });
      chunks = [];
      // Discard sub-threshold blips (too short to be real speech).
      if (durMs < VAD_MIN_UTTERANCE_MS || blob.size < 1200) {
        if (!cbs.isEnding()) cbs.onState("listening");
        return;
      }
      void transcribeSegment(blob, type);
    };
    segStart = performance.now();
    lastVoiceAt = performance.now();
    try {
      thisRec.start();
    } catch {
      rec = null;
    }
  };

  const transcribeSegment = async (blob: Blob, type: string) => {
    if (cbs.isEnding()) return;
    cbs.onState("transcribing");
    try {
      const buf = await blob.arrayBuffer();
      const bytes = Array.from(new Uint8Array(buf));
      const { invoke } = await import("@tauri-apps/api/core");
      const text = await invoke<string>("transcribe_audio", { audio: bytes, mime: type });
      if (cbs.isEnding()) return;
      if (text && text.trim()) {
        cbs.onFinal(text.trim());
      } else {
        cbs.onState("listening");
      }
    } catch (err) {
      const msg = String(err);
      if (msg.includes("no-key")) cbs.onError("Add a Groq key to enable voice (see the README).");
      else cbs.onState("listening");
    }
  };

  const poll = () => {
    if (disposed || !analyser) return;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    // RMS around the 128 midpoint → 0..~1
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    const now = performance.now();

    if (rms > VAD_SPEECH_THRESHOLD) {
      if (!speaking) {
        speaking = true;
        cbs.onSpeechStart(); // barge-in over TTS
        if (!cbs.isEnding()) cbs.onState("hearing");
        cbs.onInterim("hearing you…");
        startSegment();
      }
      lastVoiceAt = now;
    } else if (speaking) {
      // trailing silence → finalize when the pause is long enough
      if (now - lastVoiceAt > VAD_SILENCE_MS) {
        speaking = false;
        cbs.onInterim("");
        finalizeSegment();
      }
    }

    // hard cap: a very long monologue still segments so it doesn't grow unbounded
    if (speaking && now - segStart > VAD_MAX_UTTERANCE_MS) {
      speaking = false;
      cbs.onInterim("");
      finalizeSegment();
    }
  };

  const init = async () => {
    if (!inTauri()) {
      cbs.onError("Continuous voice needs the Praxis desktop app.");
      return;
    }
    try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
      if (disposed) {
        stopTracks();
        return;
      }
      mime = pickMime();
      const Ctx =
        window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      audioCtx = new Ctx();
      const src = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.4;
      src.connect(analyser);
      pollTimer = setInterval(poll, VAD_POLL_MS);
      if (!cbs.isEnding()) cbs.onState("listening");
    } catch (err) {
      const msg = String(err);
      if (msg.includes("NotAllowed") || msg.includes("Permission")) cbs.onError("Mic permission denied.");
      else if (msg.includes("NotFound") || msg.includes("Devices")) cbs.onError("No microphone found.");
      else cbs.onError("Couldn't open the microphone.");
    }
  };

  void init();

  return () => {
    disposed = true;
    if (pollTimer) clearInterval(pollTimer);
    try {
      rec?.stop();
    } catch {
      /* noop */
    }
    rec = null;
    stopTracks();
    void audioCtx?.close().catch(() => {});
    audioCtx = null;
    analyser = null;
  };
}
