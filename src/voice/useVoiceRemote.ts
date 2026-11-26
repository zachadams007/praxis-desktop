/**
 * useVoiceRemote - voice for the SECONDARY windows (Command Center, Memory Galaxy).
 *
 * These windows are the EARS; the brain window is the single mouth + executor. This
 * recognizer listens for "Praxis…" or the legacy alias (or push-to-talk via startCommand), then
 * forwards the RAW utterance to the brain over the praxis://command bus as { utterance }.
 * The brain parses it with its own area graph, runs the verb, and speaks the reply - so
 * there's exactly one voice and one source of truth regardless of which window you're in.
 * There is deliberately NO local TTS here (that would double Praxis's voice).
 *
 * The caller focus-gates `enabled` (voiceOn && window focused) so two open windows never
 * both grab the mic. The recognition lifecycle mirrors the brain's useVoice (the proven
 * reference); only the dispatch differs (forward, don't execute).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { WAKE, afterWake } from "./parse";
import { wakeChime } from "./speak";
import type { VoiceStatus } from "./types";

const COMMAND_TIMEOUT = 9000; // ms to wait for a command after waking, then stand down
const SENT_FLASH = 1100; // ms to show "thinking" after forwarding, then re-listen

const inTauri = (): boolean =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** Forward a recognized utterance to the brain (the single executor + voice) over the bus.
 *  Shared by the Web-Speech path here and the capture path (useVoiceCapture) in WebView2. */
export async function forwardUtterance(utterance: string): Promise<void> {
  if (!inTauri()) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("praxis://command", { utterance });
  } catch (err) {
    console.error("[voice-remote] forward failed:", err);
  }
}

export function useVoiceRemote(enabled: boolean) {
  const [status, setStatusState] = useState<VoiceStatus>("off");
  const [partial, setPartial] = useState("");
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const modeRef = useRef<"wake" | "command">("wake");
  const stoppingRef = useRef(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<VoiceStatus>("off");

  const setStatus = (s: VoiceStatus) => {
    statusRef.current = s;
    setStatusState(s);
  };

  // a recognized command utterance → forward to the brain, flash "thinking", re-listen
  const dispatch = useCallback(
    (raw: string) => {
      const text = raw.trim();
      modeRef.current = "wake";
      if (armTimer.current) clearTimeout(armTimer.current);
      setPartial("");
      if (!text) {
        setStatus(enabled ? "idle" : "off");
        return;
      }
      setStatus("thinking");
      void forwardUtterance(text);
      if (sentTimer.current) clearTimeout(sentTimer.current);
      sentTimer.current = setTimeout(() => {
        if (statusRef.current === "thinking") setStatus(enabled ? "idle" : "off");
      }, SENT_FLASH);
    },
    [enabled],
  );

  // imperative "talk now" - skip the wake word (mic orb / a key)
  const startCommand = useCallback(() => {
    if (statusRef.current === "off" || statusRef.current === "unsupported") return;
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

  useEffect(() => {
    if (!enabled) {
      setStatus("off");
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
      // a recognizer that's standing down can't forward (mirrors the onend guard).
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
        // if the wake utterance ALSO carried the command, forward it now
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
      if (sentTimer.current) clearTimeout(sentTimer.current);
      try {
        rec.abort();
      } catch {
        /* noop */
      }
      recRef.current = null;
      setStatus("off");
      setPartial("");
    };
  }, [enabled, dispatch]);

  return { status, partial, startCommand };
}
