/**
 * VoicePanel - the Praxis mic orb (bottom-left). Click the orb to turn voice on; then talk.
 *
 * Two engines, chosen by what the runtime can do:
 *   • Web Speech (Chrome/dev): wake-word "Praxis…" + legacy alias + push-to-talk (useVoice).
 *   • WebView2 (the packaged app): no SpeechRecognition exists, so it's PUSH-TO-TALK capture -
 *     record a clip → Groq Whisper → text (useVoiceCapture). Same command router + TTS either way.
 *
 * Honest about failures (mic blocked / no Groq key) - never a dead orb; offers a typed fallback.
 */

import { AnimatePresence, motion } from "motion/react";
import { useVoice } from "@/voice/useVoice";
import { useVoiceCapture } from "@/voice/useVoiceCapture";
import { useWindowFocus } from "@/voice/useWindowFocus";
import { canRecognize } from "@/voice/speak";
import { routeVoiceTranscript } from "@/voice/route";
import type { VoiceStatus } from "@/voice/types";
import { usePraxisStore } from "@/store/usePraxisStore";

const RECOG = canRecognize();

const LABEL: Record<VoiceStatus, string> = {
  off: "voice",
  unsupported: "voice needs a Groq key — type instead",
  denied: "mic blocked — allow it in Windows settings",
  "no-mic": "no microphone found",
  idle: RECOG ? 'say “Praxis…” or click to talk' : "click talk, then speak a command",
  armed: RECOG ? "listening…" : "recording… click to send",
  thinking: "thinking…",
  speaking: "speaking",
};

function MicGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M6 11a6 6 0 0 0 12 0M12 17v3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/** Route the recognized text: build-intent → orchestrator; nav/command → execute; else → the
 *  conversational brain (brain_chat) which replies in Praxis's voice and speaks it. */
function runTranscript(text: string) {
  void routeVoiceTranscript(text);
}

export function VoicePanel() {
  const voiceOn = usePraxisStore((s) => s.voiceOn);
  const toggleVoice = usePraxisStore((s) => s.toggleVoice);
  // only the FOCUSED window runs its mic, so the brain + a secondary window never both
  // grab it and double-fire one command. (Wake-from-anywhere is the global hotkey's job.)
  const focused = useWindowFocus();
  const ws = useVoice(RECOG && voiceOn && focused);
  const cap = useVoiceCapture(runTranscript, !RECOG && voiceOn && focused);

  const status = RECOG ? ws.status : cap.status;
  const partial = RECOG ? ws.partial : cap.partial;
  const talk = RECOG ? ws.startCommand : cap.toggle;

  const live = voiceOn && (status === "armed" || status === "thinking" || status === "speaking");
  const broken = status === "denied" || status === "no-mic" || status === "unsupported";
  const talkLabel = status === "armed" ? "■ send" : "🎙 talk now";

  return (
    <div className="voice-dock">
      <button
        className={`voice-orb ${voiceOn ? "on" : ""} st-${status}`}
        onClick={toggleVoice}
        title={voiceOn ? "turn voice off (V)" : "turn voice on (V)"}
        aria-label={voiceOn ? "turn voice off" : "turn voice on"}
      >
        <span className="voice-orb-pulse" aria-hidden />
        <span className="voice-orb-icon">
          <MicGlyph />
        </span>
      </button>

      <AnimatePresence>
        {voiceOn && (
          <motion.div
            className="voice-readout"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.24 }}
          >
            <div className={`voice-status ${broken ? "warn" : ""} ${live ? "live" : ""}`}>{LABEL[status]}</div>
            {partial && <div className="voice-partial">{partial}</div>}
            {status !== "thinking" && status !== "speaking" && status !== "denied" && status !== "no-mic" && (
              <button className="voice-talk" onClick={talk}>
                {talkLabel}
              </button>
            )}
            {(status === "denied" || status === "no-mic" || status === "unsupported") && (
              <button className="voice-talk" onClick={() => usePraxisStore.getState().setChatOpen(true)}>
                ⌨ type to Praxis
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
