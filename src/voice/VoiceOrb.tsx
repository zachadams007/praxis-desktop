/**
 * VoiceOrb - the Praxis mic affordance for the secondary windows (Command Center,
 * Memory Galaxy). A glowing orb you click to wake Praxis's voice in THIS window; once on,
 * it listens for "Praxis…" or the legacy alias (or "talk now" to skip the wake word), shows the live
 * transcript, and forwards what it hears to the brain. Honest about failures - never a dead
 * orb. Presentational: the recognizer lives in useVoiceRemote; this just renders its state.
 *
 * Self-contained styling (voiceOrb.css) themed by the `accent` prop so it sits naturally in
 * whatever window mounts it, without depending on the brain's design tokens.
 */
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import type { VoiceStatus } from "./types";
import "./voiceOrb.css";

const LABEL: Record<VoiceStatus, string> = {
  off: "voice",
  unsupported: "voice needs a Groq key (see README)",
  denied: "mic blocked — allow it in Windows settings",
  "no-mic": "no microphone found",
  idle: "click talk, then speak",
  armed: "recording… click to send",
  thinking: "→ asking Praxis",
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

export interface VoiceOrbProps {
  on: boolean;
  onToggle: () => void;
  status: VoiceStatus;
  partial: string;
  startCommand: () => void;
  /** window theme accent (CSS color). Drives the glow + transcript hue. */
  accent?: string;
}

export function VoiceOrb({ on, onToggle, status, partial, startCommand, accent = "#3b6cff" }: VoiceOrbProps) {
  const live = on && (status === "armed" || status === "thinking" || status === "speaking");
  const broken = status === "denied" || status === "no-mic" || status === "unsupported";

  return (
    // MotionConfig here (not just the brain's) so the readout honors prefers-reduced-motion
    // in the secondary windows that actually mount this orb.
    <MotionConfig reducedMotion="user">
    <div className="vo-dock" style={{ ["--vo" as string]: accent }}>
      <button
        className={`vo-orb ${on ? "on" : ""} st-${status}`}
        onClick={onToggle}
        title={on ? "turn voice off (V)" : "turn voice on (V)"}
        aria-label={on ? "turn voice off" : "turn voice on"}
        aria-pressed={on}
      >
        <span className="vo-pulse" aria-hidden />
        <span className="vo-icon">
          <MicGlyph />
        </span>
      </button>

      <AnimatePresence>
        {on && (
          <motion.div
            className="vo-readout"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.24 }}
          >
            <div className={`vo-status ${broken ? "warn" : ""} ${live ? "live" : ""}`}>{LABEL[status]}</div>
            {partial && <div className="vo-partial">{partial}</div>}
            {status !== "thinking" && status !== "speaking" && status !== "denied" && status !== "no-mic" && (
              <button className="vo-talk" onClick={startCommand}>
                {status === "armed" ? "■ send" : "🎙 talk now"}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </MotionConfig>
  );
}
