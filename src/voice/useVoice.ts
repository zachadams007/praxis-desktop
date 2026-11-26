/**
 * useVoice - the Praxis loop in the BRAIN window: listen → understand → answer aloud.
 *
 * The packaged Tauri app does NOT use WebView2 `SpeechRecognition`; WebView2 exposes
 * the constructor but has no usable recognition backend. This hook is kept for the
 * real-browser/dev Web Speech path. Packaged voice uses `useVoiceCapture` -> Rust
 * `voice_stt`/Groq capture, while `speak()` still owns TTS. The state machine:
 *
 *   idle ──(hear wake word)──▶ armed ──(next utterance)──▶ thinking
 *     ▲                                                               │
 *     └───────────────── speaking ◀──(speak the reply)───────────────┘
 *
 * You can also skip the wake word with `startCommand()` (the mic orb / a key) -
 * push-to-talk. Speaking while Praxis talks barges in (cancels the TTS). Every failure
 * surfaces a clear status; it's never a silently dead mic.
 *
 * Command EXECUTION lives in ./execute (shared with the cross-window bus). This hook owns
 * the recognition lifecycle + component status; the secondary windows use useVoiceRemote.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { cancelSpeech, canSpeak, primeVoices, wakeChime } from "./speak";
import { afterWake, WAKE } from "./parse";
import { routeVoiceTranscript } from "./route";
import type { VoiceStatus, VoiceState } from "./types";

export type { VoiceStatus, VoiceState } from "./types";

const COMMAND_TIMEOUT = 9000; // ms to wait for a command after waking, then stand down

export function useVoice(enabled: boolean) {
  const [state, setState] = useState<VoiceState>({ status: "off", partial: "", lastReply: "" });
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const modeRef = useRef<"wake" | "command">("wake");
  const stoppingRef = useRef(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<VoiceStatus>("off");

  const setStatus = (s: VoiceStatus) => {
    statusRef.current = s;
    setState((p) => ({ ...p, status: s }));
  };
  const setPartial = (t: string) => setState((p) => ({ ...p, partial: t }));

  // dispatch a recognized utterance → command router (real verbs) → spoken reply,
  // falling back to the canned planner only for genuine questions
  const dispatch = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      modeRef.current = "wake";
      if (armTimer.current) clearTimeout(armTimer.current);
      if (!text) {
        setStatus(enabled ? "idle" : "off");
        return;
      }
      setPartial("");
      setStatus("thinking");
      cancelSpeech();

      const result = await routeVoiceTranscript(text);
      setState((p) => ({ ...p, lastReply: result.summary }));
      setStatus(enabled ? "idle" : "off");
    },
    [enabled],
  );

  // imperative "talk now" - skip the wake word (mic orb / V-hold)
  const startCommand = useCallback(() => {
    if (statusRef.current === "off" || statusRef.current === "unsupported") return;
    cancelSpeech();
    modeRef.current = "command";
    wakeChime();
    setPartial("");
    setStatus("armed");
    if (armTimer.current) clearTimeout(armTimer.current);
    armTimer.current = setTimeout(() => {
      if (modeRef.current === "command") {
        modeRef.current = "wake";
        setStatus("idle");
      }
    }, COMMAND_TIMEOUT);
  }, []);

  // DEV bridge: run a voice command by text (no mic) - `window.__praxisVoice("open the journey")`.
  // Lets the command path be tested headless and lets the owner try phrasings without speaking.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __praxisVoice?: (t: string) => void };
    w.__praxisVoice = (t: string) => dispatch(t);
    return () => {
      delete w.__praxisVoice;
    };
  }, [dispatch]);

  useEffect(() => {
    if (!enabled) {
      setStatus("off");
      return;
    }
    if (!canSpeak()) {
      setStatus("unsupported");
      return;
    }
    const w = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      setStatus("unsupported");
      return;
    }
    primeVoices();
    stoppingRef.current = false;
    modeRef.current = "wake";

    const rec = new Ctor();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    recRef.current = rec;

    rec.onstart = () => {
      if (statusRef.current === "off") setStatus("idle");
    };

    rec.onresult = (e) => {
      // a final result can already be queued when we abort() on teardown/blur - drop it so
      // a recognizer that's standing down can't dispatch (mirrors the onend guard).
      if (stoppingRef.current) return;
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r[0]?.transcript ?? "";
        if (r.isFinal) final += t;
        else interim += t;
      }
      const live = (final || interim).trim();

      // barge-in: talking over Praxis cancels its speech and re-listens
      if (statusRef.current === "speaking" && live) {
        cancelSpeech();
        modeRef.current = "wake";
        setStatus("idle");
      }

      if (modeRef.current === "command") {
        setPartial(live);
        if (final.trim()) dispatch(final);
        return;
      }

      // wake mode - watch for the wake word
      if (WAKE.test(live)) {
        setPartial(live);
        if (statusRef.current === "idle") {
          wakeChime();
          setStatus("armed");
          modeRef.current = "command";
          if (armTimer.current) clearTimeout(armTimer.current);
          armTimer.current = setTimeout(() => {
            if (modeRef.current === "command") {
              modeRef.current = "wake";
              setStatus("idle");
            }
          }, COMMAND_TIMEOUT);
        }
        // if the wake utterance ALSO carried the command, run it now
        if (final.trim()) {
          const cmd = afterWake(final);
          if (cmd) dispatch(cmd);
        }
      } else {
        setPartial(""); // ignore ambient chatter that lacks the wake word
      }
    };

    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") setStatus("denied");
      else if (e.error === "audio-capture") setStatus("no-mic");
      // 'no-speech' | 'network' | 'aborted' → transient; onend restarts
    };

    rec.onend = () => {
      // continuous recognition stops itself periodically - restart unless we're tearing down
      if (!stoppingRef.current && statusRef.current !== "denied" && statusRef.current !== "no-mic") {
        try {
          rec.start();
        } catch {
          /* already starting - ignore */
        }
      }
    };

    try {
      rec.start();
      setStatus("idle");
    } catch {
      setStatus("unsupported");
    }

    return () => {
      stoppingRef.current = true;
      if (armTimer.current) clearTimeout(armTimer.current);
      try {
        rec.abort();
      } catch {
        /* noop */
      }
      cancelSpeech();
      recRef.current = null;
      setState((p) => ({ ...p, status: "off", partial: "" }));
    };
  }, [enabled, dispatch]);

  return { ...state, startCommand };
}
