/**
 * VoiceStateIndicator - the corner pill that CONFIRMS THE STATE of a live voice
 * session, and nothing else.
 *
 * It used to be a 340px panel carrying the whole running transcript. That was the
 * wrong surface for it: Atlas is the voice assistant, so the conversation belongs in
 * the Atlas chat panel (OrchestratorPanel, left side) where the typed lane already
 * lives. What the owner wants in the corner is the small confirmation - is it listening,
 * is it talking, is it working, how long has this been going, which speech stack is
 * live, and how to stop it. So this renders exactly that: state + timer + transport
 * badge + hint, in one pill.
 *
 * Two ways to use it:
 *   OWNER - the window running the session (HybridSession) passes its real live
 *             values and supplies the end control, since only that window can end it.
 *   READER - any other Praxis window renders <VoiceStateSatellite/>, which draws
 *             the same pill from the VOICE_POPUP_STATE broadcast. It owns no mic and
 *             offers no controls it cannot actually perform.
 *
 * Tauri uses one click-through desktop overlay. Plain browser dev views retain
 * the focused/last-focused window fallback through localStorage.
 *
 * Styling lives in voicePopup.css (.vsi-*), on the same electric-dark tokens as the
 * corner widget it replaces.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  VOICE_POPUP_STATE,
  VOICE_POPUP_STATE_STALE_MS,
  VOICE_POPUP_STATE_TAURI,
  announceVoicePopupState,
  coerceVoicePopupState,
  praxisWindowKey,
  readCachedVoicePopupState,
  type VoicePopupLiveState,
  type VoicePopupState,
} from "./voiceEvents";
import "./voicePopup.css";

/** Which Praxis window currently owns the on-screen indicator. */
const SURFACE_CLAIM_KEY = "praxis.voice.surface.v1";

const STATE_LABEL: Record<VoicePopupLiveState, string> = {
  listening: "listening",
  hearing: "hearing you",
  transcribing: "transcribing",
  acting: "working",
  speaking: "speaking",
};

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

function readSurfaceClaim(): string | null {
  try {
    const raw = JSON.parse(localStorage.getItem(SURFACE_CLAIM_KEY) ?? "null") as { key?: unknown } | null;
    return raw && typeof raw.key === "string" ? raw.key : null;
  } catch {
    return null;
  }
}

/**
 * True when THIS window should draw the indicator: it has focus, or it was the last
 * Praxis window that did. Fails OPEN - if localStorage is unusable there is no claim
 * to read, and showing the state everywhere beats showing it nowhere.
 */
export function useVoiceSurfaceFocus(): boolean {
  const me = praxisWindowKey();
  const [owner, setOwner] = useState<string | null>(() => readSurfaceClaim());

  useEffect(() => {
    if (inTauri()) return; // The native overlay is the only desktop pill.
    const claim = () => {
      if (typeof document === "undefined") return;
      if (!document.hasFocus() || document.hidden) return;
      try {
        localStorage.setItem(SURFACE_CLAIM_KEY, JSON.stringify({ key: me, ts: Date.now() }));
      } catch {
        /* no storage - every window falls open below */
      }
      setOwner(me);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SURFACE_CLAIM_KEY) return;
      setOwner(readSurfaceClaim());
    };
    claim();
    window.addEventListener("focus", claim);
    document.addEventListener("visibilitychange", claim);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("focus", claim);
      document.removeEventListener("visibilitychange", claim);
      window.removeEventListener("storage", onStorage);
    };
  }, [me]);

  return !inTauri() && (owner === null || owner === me);
}

/** A 1s tick, only while `on`. Used for the elapsed timer and to age out a state
 *  whose publisher went quiet. */
function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  return now;
}

/**
 * The live session state as broadcast by whichever window owns it. Returns null when
 * no session is running - including when the owner stopped publishing (crashed or
 * closed), which is why the state carries a timestamp and gets aged out.
 */
export function useBroadcastVoiceState(): VoicePopupState | null {
  const [state, setState] = useState<VoicePopupState | null>(() => readCachedVoicePopupState());

  useEffect(() => {
    const onLocal = (e: Event) => {
      const next = coerceVoicePopupState((e as CustomEvent<VoicePopupState>).detail);
      if (next) setState(next);
    };
    window.addEventListener(VOICE_POPUP_STATE, onLocal);

    let off: (() => void) | undefined;
    let disposed = false;
    if (inTauri()) {
      void import("@tauri-apps/api/event")
        .then(({ listen }) =>
          listen<unknown>(VOICE_POPUP_STATE_TAURI, (e) => {
            const next = coerceVoicePopupState(e.payload);
            if (next) setState(next);
          }),
        )
        .then((f) => {
          if (disposed) f();
          else off = f;
        })
        .catch(() => {
          /* not inside the Tauri shell */
        });
    }
    return () => {
      disposed = true;
      window.removeEventListener(VOICE_POPUP_STATE, onLocal);
      off?.();
    };
  }, []);

  const now = useTick(state?.active === true);
  if (!state || !state.active) return null;
  return Math.max(now, Date.now()) - state.ts > VOICE_POPUP_STATE_STALE_MS ? null : state;
}

export interface VoiceStateIndicatorProps {
  state: VoicePopupLiveState;
  /** True only while audio is actually playing. */
  speaking: boolean;
  transport: "realtime" | "local";
  /** Epoch ms the session started - the timer ticks from this. */
  startedAt: number;
  notice?: string | null;
  /** Mic/transport failure. When set, the pill reports THAT instead of a listening
   *  state it cannot substantiate. */
  error?: string | null;
  /** Tap-to-interrupt while speaking. Omitted by readers that can't actually stop it. */
  onInterrupt?: () => void;
  /** The end control, supplied by the window that owns the session. */
  endButton?: ReactNode;
  /** What actually ends the session from here (rendered under the pill). */
  hint?: string;
}

/** The pill itself - pure presentation, no mic, no session ownership. */
export function VoiceStateIndicator({
  state,
  speaking,
  transport,
  startedAt,
  notice,
  error,
  onInterrupt,
  endButton,
  hint = "Esc or Ctrl+T to end",
}: VoiceStateIndicatorProps) {
  const now = useTick(true);
  // The electric halo means "the mic is genuinely open". A mic/transport failure is
  // exactly when it is not, so an error kills the halo as well as the label -
  // otherwise the pill says "denied" while still glowing like it's listening.
  const live = !error && (state === "listening" || state === "hearing");
  const canInterrupt = speaking && !error && !!onInterrupt;

  return (
    <MotionConfig reducedMotion="user">
      <motion.div
        className="vsi-root"
        role="status"
        aria-live="polite"
        aria-label="Atlas voice session"
        initial={{ opacity: 0, y: 12, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.96 }}
        transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className={`vsi-pill ${error ? "err" : state} ${live ? "live" : ""}`}>
          {/*
            ATLAS, always. There is one voice assistant and this is it - hold-T and
            CONVERSE are two ways of taking a turn with the same one, not two
            assistants. The pill used to head itself "Praxis", which read as a
            second entity and sent the owner looking for the difference between them.
          */}
          <span className="vsi-who" aria-hidden>ATLAS</span>
          {error ? (
            <span className="vsi-err" title={error}>
              {error}
            </span>
          ) : (
            <>
              <button
                className={`vsi-state ${canInterrupt ? "interruptible" : ""}`}
                type="button"
                onClick={canInterrupt ? onInterrupt : undefined}
                aria-label={canInterrupt ? "Tap to interrupt" : STATE_LABEL[state]}
                title={canInterrupt ? "Tap to interrupt" : STATE_LABEL[state]}
                tabIndex={canInterrupt ? 0 : -1}
              >
                <span className="vsi-viz" aria-hidden>
                  <span className="vsi-bar" />
                  <span className="vsi-bar" />
                  <span className="vsi-bar" />
                </span>
                <span className="vsi-label">{STATE_LABEL[state]}</span>
              </button>
              <span className="vsi-timer" aria-label="Session time">
                {fmtElapsed(now - startedAt)}
              </span>
              <span
                className={`vsi-transport ${transport}`}
                title={
                  transport === "realtime"
                    ? "OpenAI GPT-Realtime-2 — speech-to-speech"
                    : "Local voice stack (Groq / NIM / Orpheus)"
                }
              >
                {transport}
              </span>
            </>
          )}
          {endButton}
        </div>

        <AnimatePresence>
          {notice && (
            <motion.div
              className="vsi-notice"
              key="notice"
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              {notice}
            </motion.div>
          )}
        </AnimatePresence>

        <span className="vsi-hint" aria-hidden>
          {hint}
        </span>
      </motion.div>
    </MotionConfig>
  );
}

/**
 * Drop-in for every Praxis window that does NOT own the session (Command Center,
 * Memory Galaxy, Flight Deck). Renders nothing unless a session is genuinely running
 * AND this window is the one the owner is working in.
 *
 * It deliberately offers no interrupt and no close: this window can't stop the audio
 * or tear the session down, and a control that doesn't do what it says is worse than
 * no control. Ctrl+T ends the session from anywhere (Rust routes the global
 * accelerator to the session owner), so that is what the hint says.
 */
export function VoiceStateSatellite({ overlay = false }: { overlay?: boolean } = {}) {
  const state = useBroadcastVoiceState();
  const mine = useVoiceSurfaceFocus();
  const showing = !!state && (overlay || mine);
  return (
    <AnimatePresence>
      {showing && (
        <VoiceStateIndicator
          key="voice-state-satellite"
          state={state.state}
          speaking={state.speaking}
          transport={state.transport}
          startedAt={state.startedAt}
          notice={state.notice}
          error={state.error}
          hint={state.mode === "once" ? "Ctrl+T to send or stop" : "Ctrl+T to end"}
        />
      )}
    </AnimatePresence>
  );
}

/**
 * Publish this window's live session state on a slow heartbeat while `active`, and
 * publish `active:false` the moment it stops.
 *
 * The heartbeat exists so readers can age the state out: a session that goes quiet
 * for a minute of listening is normal, but an owner that DIED must not leave a
 * LISTENING pill glowing in another window forever.
 */
export function usePublishVoicePopupState(
  active: boolean,
  payload: Omit<VoicePopupState, "active" | "ts" | "startedAt">,
  startedAt: number,
): void {
  const latest = useRef(payload);
  latest.current = payload;

  useEffect(() => {
    announceVoicePopupState({ active, startedAt, ...latest.current });
    if (!active) return;
    const id = window.setInterval(
      () => announceVoicePopupState({ active: true, startedAt, ...latest.current }),
      20_000,
    );
    return () => window.clearInterval(id);
    // `payload` is read through `latest` at publish time; re-publishing on every
    // field change is intentional and cheap (a state transition, not a keystroke).
  }, [active, startedAt, payload.state, payload.speaking, payload.transport, payload.notice, payload.error, payload.mode]);

  // Session over (or this window unmounted mid-session) → say so, once, so no other
  // window is left drawing a session that no longer exists.
  useEffect(() => {
    return () => {
      announceVoicePopupState({
        active: false,
        startedAt,
        state: "listening",
        speaking: false,
        transport: latest.current.transport,
        notice: null,
        error: null,
      });
    };
  }, [startedAt]);
}
