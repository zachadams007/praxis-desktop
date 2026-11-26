/**
 * VoicePopup - the one owner of the voice session in the MAIN brain window.
 *
 * Only CONVERSE reached the Realtime session. Now every entry mounts <HybridSession>, and only
 * its length differs:
 *
 *   Ctrl+T (global), V, the Talk button   → a single turn; pressing again sends it
 *                                           (or stops a turn already being answered)
 *   hold T in this window                  → a single turn; releasing T sends it
 *   CONVERSE, or Space right after Ctrl+T  → the same session, continuous
 *
 * While no session is running, the corner only offers a stop control for speech
 * Praxis started elsewhere (a typed answer read aloud).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { cancelSpeech, isSpeaking, onSpeakingChange } from "./speak";
import { HybridSession } from "./HybridSession";
import type { VoiceSessionMode } from "./useHybridSession";
import {
  VOICE_CONVERSATION,
  VOICE_HOLD_END,
  VOICE_HOLD_START,
  VOICE_ONCE_TEXT,
  VOICE_TOGGLE,
  announceConversationState,
} from "./voiceEvents";
import "./voicePopup.css";

const inTauri = (): boolean =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/**
 * Ctrl+T then Space within this window turns the single turn into a conversation.
 * Tauri global accelerators can't encode two non-modifier keys, so the chord is
 * Ctrl+T (global) followed by a Space this window hears.
 */
const CHORD_MS = 1500;

interface Session {
  mode: VoiceSessionMode;
  /** Also the session's React key: a new press after a finished turn is a new session. */
  startedAt: number;
  /** Words another Praxis window already captured; the turn skips the mic. */
  initialText?: string;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)
  );
}

export function VoicePopup() {
  const [session, setSession] = useState<Session | null>(null);
  const [sendNowToken, setSendNowToken] = useState(0);
  const [holding, setHolding] = useState(false);
  const [straySpeech, setStraySpeech] = useState(() => isSpeaking());
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const start = useCallback((mode: VoiceSessionMode) => {
    // A new turn always silences whatever Praxis was saying.
    cancelSpeech();
    setSession({ mode, startedAt: Date.now() });
  }, []);

  const end = useCallback(() => {
    setHolding(false);
    setSession(null);
  }, []);

  /** Ctrl+T, V, Talk: start a turn; press again to send it, or stop a conversation. */
  const toggle = useCallback(() => {
    const current = sessionRef.current;
    if (!current) start("once");
    else if (current.mode === "once") setSendNowToken((n) => n + 1);
    else end();
  }, [start, end]);

  /** CONVERSE: start a conversation, turn an open single turn into one, or end it. */
  const converse = useCallback(() => {
    const current = sessionRef.current;
    if (!current) start("continuous");
    else if (current.mode === "once") setSession({ ...current, mode: "continuous" });
    else end();
  }, [start, end]);

  const holdStart = useCallback(() => {
    const current = sessionRef.current;
    setHolding(true);
    // Holding T over a single turn that is being answered starts a fresh one; a
    // conversation is already listening.
    if (!current || current.mode === "once") start("once");
  }, [start]);

  const holdEnd = useCallback(() => {
    setHolding(false);
    if (sessionRef.current?.mode === "once") setSendNowToken((n) => n + 1);
  }, []);

  // Listeners bind once; they call through refs so they are never stale.
  const handlers = useRef({ toggle, converse, holdStart, holdEnd });
  handlers.current = { toggle, converse, holdStart, holdEnd };

  useEffect(() => {
    const onToggle = () => handlers.current.toggle();
    const onConversation = () => handlers.current.converse();
    const onHoldStart = () => handlers.current.holdStart();
    const onHoldEnd = () => handlers.current.holdEnd();
    // Another window's mic heard it (Memory Galaxy's talk button): same session, words in hand.
    const onOnceText = (e: Event) => {
      const text = (e as CustomEvent<unknown>).detail;
      if (typeof text !== "string" || !text.trim() || sessionRef.current?.mode === "continuous") return;
      cancelSpeech();
      setSession({ mode: "once", startedAt: Date.now(), initialText: text.trim() });
    };
    window.addEventListener(VOICE_TOGGLE, onToggle);
    window.addEventListener(VOICE_CONVERSATION, onConversation);
    window.addEventListener(VOICE_HOLD_START, onHoldStart);
    window.addEventListener(VOICE_HOLD_END, onHoldEnd);
    window.addEventListener(VOICE_ONCE_TEXT, onOnceText);

    // Global Ctrl+T: Rust emits praxis://voice-toggle to this window whichever app
    // has focus, so the owner never has to click Praxis first.
    let unlisten: (() => void) | undefined;
    let disposed = false;
    if (inTauri()) {
      void import("@tauri-apps/api/event")
        .then(({ listen }) => listen<void>("praxis://voice-toggle", onToggle))
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {
          /* not inside the Tauri shell */
        });
    }
    return () => {
      disposed = true;
      window.removeEventListener(VOICE_TOGGLE, onToggle);
      window.removeEventListener(VOICE_CONVERSATION, onConversation);
      window.removeEventListener(VOICE_HOLD_START, onHoldStart);
      window.removeEventListener(VOICE_HOLD_END, onHoldEnd);
      window.removeEventListener(VOICE_ONCE_TEXT, onOnceText);
      unlisten?.();
    };
  }, []);

  // Ctrl+T → Space: the single turn that just opened becomes a conversation.
  useEffect(() => {
    if (session?.mode !== "once") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      const current = sessionRef.current;
      if (!current || current.mode !== "once" || Date.now() - current.startedAt > CHORD_MS) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      setSession({ ...current, mode: "continuous" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session?.mode]);

  // The CONVERSE button renders this, not its own guess. A single turn is not a
  // conversation, so it reads as off.
  useEffect(() => {
    announceConversationState(session?.mode === "continuous");
  }, [session?.mode]);

  useEffect(() => onSpeakingChange(setStraySpeech), []);

  if (session) {
    return (
      <AnimatePresence>
        <HybridSession
          key={session.startedAt}
          mode={session.mode}
          initialText={session.initialText}
          sendNowToken={sendNowToken}
          holding={holding}
          onEnd={end}
        />
      </AnimatePresence>
    );
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="vp-root" role="region" aria-label="Praxis voice">
        <AnimatePresence>
          {straySpeech && (
            <motion.button
              className="vp-pill live"
              onClick={() => cancelSpeech()}
              title="Stop Praxis talking"
              initial={{ opacity: 0, x: 10, scale: 0.92 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 10, scale: 0.92 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              aria-live="polite"
            >
              <span className="vp-pill-dot" aria-hidden />
              speaking · click to stop
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
