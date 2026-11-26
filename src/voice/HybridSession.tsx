/**
 * HybridSession - the Praxis continuous session: the engine, plus the small corner
 * indicator that confirms its state.
 *
 * When Ctrl+T's single-shot popup LOCKS into continuous mode (Space within ~1.5s, or
 * the CONVERSE button), this mounts and owns the mic for the session's lifetime.
 *
 * It used to ALSO render the running transcript - every utterance and how it
 * resolved - in a 340px corner panel. That was the wrong home for it. Atlas is the
 * voice assistant, so the conversation belongs in the Atlas chat panel on the left
 * (OrchestratorPanel), which is where the typed lane already lives and where the owner
 * looks for it; atlasChatBridge mirrors both halves of every turn there, live. The
 * corner keeps only what it was always meant to be: is it listening, is it talking,
 * is it working, how long, which speech stack, and how to stop - one pill
 * (VoiceStateIndicator), a fraction of the old footprint.
 *
 * Ends on Esc, the close button, or Ctrl+T (handled by VoicePopup).
 *
 * Tauri broadcasts to the desktop voicepill overlay. Browser dev views keep the
 * focused-window pill. The session itself never pauses when the drawing moves.
 */

import { useCallback, useEffect, useRef } from "react";
import { AnimatePresence } from "motion/react";
import { useHybridSession, type VoiceSessionMode } from "./useHybridSession";
import {
  VoiceStateIndicator,
  useVoiceSurfaceFocus,
  usePublishVoicePopupState,
} from "./VoiceStateIndicator";
// NOTE: hybridSession.css is no longer imported - every .hs-* rule in it described
// the transcript panel this file used to render. The pill's styles live in
// voicePopup.css (.vsi-*), which VoiceStateIndicator imports. That stylesheet is now
// unreferenced and should be deleted.

export interface HybridSessionProps {
  /** End the session (Esc / close button / Ctrl+T). */
  onEnd: () => void;
  /** "once" for Ctrl+T / hold T; "continuous" for CONVERSE. Can move once → continuous. */
  mode?: VoiceSessionMode;
  /** Bumped by VoicePopup when Ctrl+T is pressed again or T is released. */
  sendNowToken?: number;
  /** T is currently held down. */
  holding?: boolean;
  /** A single turn whose words another window already captured. */
  initialText?: string;
}

/** What actually ends or sends from the keyboard, per session length. */
export function sessionHint(mode: VoiceSessionMode): string {
  return mode === "once" ? "Ctrl+T sends · Esc cancels" : "Esc or Ctrl+T to end";
}

export function HybridSession({
  onEnd,
  mode = "continuous",
  sendNowToken = 0,
  holding = false,
  initialText,
}: HybridSessionProps) {
  // `feed` and `interim` are deliberately not read any more: that is the transcript,
  // and the transcript now lives in the Atlas panel. The hook still produces them -
  // routing and the Atlas mirror both depend on that pipeline - this surface just
  // isn't the place it gets drawn.
  // A quiet-stretch pause closes the session the same way Esc does (the hook calls
  // this through a ref), instead of leaving a second engine listening. A single turn
  // that has played out closes the same way.
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const { liveState, speaking, interrupt, endSession, micError, transportKind, transportNotice } =
    useHybridSession(true, () => onEndRef.current(), {
      mode,
      sendNowToken,
      holding,
      initialText,
      onOnceDone: () => onEndRef.current(),
    });

  const end = useCallback(() => {
    endSession();
    onEnd();
  }, [endSession, onEnd]);

  // Esc ends the session (barge-in for speech is handled globally elsewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        end();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [end]);

  // Fixed at mount rather than derived from elapsedMs, so the timer other windows
  // draw doesn't wobble by a second against this one's.
  const startedAtRef = useRef(Date.now());

  // Broadcast the live state so the indicator can appear in whichever Praxis window
  // has focus. Publishing is unconditional - the session keeps running (and keeps
  // saying so) even when this window is the one that stops drawing it.
  usePublishVoicePopupState(
    true,
    {
      state: liveState,
      speaking,
      transport: transportKind,
      notice: transportNotice,
      error: micError,
      mode,
    },
    startedAtRef.current,
  );

  // Browser-only fallback. In Tauri the dedicated voicepill is the only surface.
  // This gates the DRAWING only - the hook above stays mounted and the mic stays live.
  const mine = useVoiceSurfaceFocus();

  return (
    <AnimatePresence>
      {mine && (
        <VoiceStateIndicator
          key="voice-state"
          state={liveState}
          speaking={speaking}
          transport={transportKind}
          startedAt={startedAtRef.current}
          notice={transportNotice}
          error={micError}
          onInterrupt={interrupt}
          hint={sessionHint(mode)}
          endButton={
            <button className="vsi-close" onClick={end} aria-label="End session" title="End session (Esc)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
          }
        />
      )}
    </AnimatePresence>
  );
}
