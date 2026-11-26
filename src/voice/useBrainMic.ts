/**
 * useBrainMic - the ONE voice control for the brain window (drives the top "Voice" chip and
 * the hold-to-talk T key). Replaces the old two-step (corner orb to arm, then "talk now").
 *
 *   • click the Voice chip  → toggle() starts listening immediately; click again sends.
 *   • hold the T key        → start() on keydown, stop()/send on keyup (push-to-talk).
 *
 * Picks the engine by runtime: Web Speech in a real browser (dev), the Groq capture path in
 * the packaged WebView2 app. Always "ready" while the window is focused - push-to-talk means
 * the mic only opens when you actually press, so there's no always-on listening to gate.
 */
import { useEffect, useRef } from "react";
import { useVoice } from "./useVoice";
import { useVoiceCapture } from "./useVoiceCapture";
import { useWindowFocus } from "./useWindowFocus";
import { canRecognize } from "./speak";
import { routeVoiceTranscript } from "./route";
import { usePraxisStore } from "@/store/usePraxisStore";
import type { VoiceStatus } from "./types";

const RECOG = canRecognize();
const noop = () => {};

/** Route final speech through one backend: build goals -> A3, app commands -> Praxis
 *  verbs, ordinary questions -> brain_chat. */
function runTranscript(text: string) {
  void routeVoiceTranscript(text);
}

export interface BrainMic {
  status: VoiceStatus;
  partial: string;
  /** start listening (push-to-talk keydown / one-press) */
  start: () => void;
  /** stop + send (push-to-talk keyup) */
  stop: () => void;
  /** start, or send if already listening (chip click) */
  toggle: () => void;
  listening: boolean;
}

export function useBrainMic(
  /** Called with the FINAL Groq transcript before the command router runs.
   *  Return true to handle it and skip the default route.
   *  Only fires on the Groq/WebView2 path (packaged app); no-op in Web Speech dev mode. */
  onFinal?: (t: string) => boolean | void | Promise<boolean | void>,
  /** Keep this mic capturable even when the window is NOT focused - for the always-on corner
   *  popup driven by the GLOBAL Ctrl+T (Wispr-style background listening, no window movement). */
  alwaysOn = false,
  /** Hard-disable BOTH engines - used to stand the single-shot popup mic down while the
   *  continuous Hybrid session owns the mic (one recognizer at a time; no dual capture). */
  enabled = true,
): BrainMic {
  const focused = useWindowFocus();
  const ws = useVoice(enabled && RECOG && focused); // dev/browser: wake-word + push-to-talk
  const cap = useVoiceCapture(runTranscript, enabled && !RECOG && (alwaysOn || focused), onFinal); // app: Groq push-to-talk

  const status = RECOG ? ws.status : cap.status;
  const partial = RECOG ? ws.partial : cap.partial;
  const start = RECOG ? ws.startCommand : cap.start;
  const stop = RECOG ? noop : cap.stop;
  const toggle = RECOG ? ws.startCommand : cap.toggle;
  const listening = status === "armed" || status === "thinking" || status === "speaking";

  const wasListening = useRef(false);
  useEffect(() => {
    const listeningNow = (focused || alwaysOn) && status === "armed";
    if (listeningNow) {
      usePraxisStore.getState().setVoiceListening(true);
      wasListening.current = true;
    } else if (wasListening.current) {
      usePraxisStore.getState().setVoiceListening(false);
      wasListening.current = false;
    }
  }, [focused, status, alwaysOn]);

  return { status, partial, start, stop, toggle, listening };
}
