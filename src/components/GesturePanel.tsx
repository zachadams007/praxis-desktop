/**
 * GesturePanel - shows only in gesture nav mode. Renders the webcam feed with the
 * premium neon hand overlay, a live readout of the gesture you're making, and a
 * compact legend of the vocabulary so nothing is a hidden secret. Never a silent
 * dead toggle: every non-tracking state says exactly what's wrong.
 */

import { motion } from "motion/react";
import { useHandGesture, type GestureStatus } from "@/gesture/useHandGesture";
import { usePraxisStore } from "@/store/usePraxisStore";

const STATUS_TEXT: Record<GestureStatus, string> = {
  off: "",
  loading: "starting camera + hand tracker…",
  tracking: "",
  "no-camera": "no camera available on this device",
  denied: "camera permission denied — allow it to use gesture nav",
  error: "hand tracker unavailable (needs network for the model this phase)",
};

/** The gesture vocabulary, shown as a legend under the feed. */
const LEGEND: { glyph: string; verb: string; how: string }[] = [
  { glyph: "✊", verb: "Grab + move", how: "pan — Praxis follows your hand" },
  { glyph: "👉", verb: "Point fingers in", how: "dive into the cluster you point at" },
  { glyph: "✊", verb: "Fist + pull back", how: "back out — task → lane → overview" },
  { glyph: "↻", verb: "Fist up + twist", how: "flip journey ⇄ brain" },
  { glyph: "🤏", verb: "Pinch + up/down", how: "zoom in / out" },
];

export function GesturePanel() {
  const mode = usePraxisStore((s) => s.mode);
  const viewMode = usePraxisStore((s) => s.viewMode);
  const active = mode === "gesture";
  const { videoRef, canvasRef, status, hud } = useHandGesture(active);

  if (!active) return null;

  const journey = viewMode === "journey";

  return (
    <motion.div
      className={`gesture-panel${journey ? " is-journey" : ""}`}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="gesture-cam">
        <video ref={videoRef} muted playsInline className="gesture-video" />
        <canvas ref={canvasRef} className="gesture-overlay" />
        {status !== "tracking" && (
          <div className="gesture-status">
            {status === "loading" && <span className="spin" />}
            {STATUS_TEXT[status]}
          </div>
        )}
        {status === "tracking" && (
          <div className={`gesture-readout ${hud.pose !== "none" ? "live" : ""}`}>
            {hud.label || "✋ raise your hand to begin"}
          </div>
        )}
      </div>

      {status === "tracking" && (
        <div className="gesture-legend">
          {LEGEND.map((g) => (
            <div className="gesture-legend-row" key={g.verb}>
              <span className="gesture-legend-glyph">{g.glyph}</span>
              <span className="gesture-legend-verb">{g.verb}</span>
              <span className="gesture-legend-how">{g.how}</span>
            </div>
          ))}
        </div>
      )}

      <div className="gesture-foot">
        <div>
          <span className="gesture-title">gesture nav</span>
          <span className="gesture-sub">neural field · live</span>
        </div>
        <button className="gesture-exit" onClick={() => usePraxisStore.getState().setMode("orbit")}>
          exit
        </button>
      </div>
    </motion.div>
  );
}
