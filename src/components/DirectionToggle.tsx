/**
 * DirectionToggle - THE live in-app switch between the two rendered visual
 * candidates (honors "everything is a toggle"). It floats top-center over both
 * shells so the owner can flip between them and judge the winner without a reload.
 *
 *   Neural Field - the evolved volumetric connectome brain (3D neural space)
 *   Atlas - the isometric task-city (premium bento dashboard)
 *
 * Presentational only: a segmented control with a motion-driven active pill that
 * slides between the two segments. Reduced-motion → instant (MotionConfig at the
 * app root already honors the OS setting).
 */

import { motion } from "motion/react";
import { usePraxisStore, type Direction } from "@/store/usePraxisStore";

const SEGMENTS: { id: Direction; label: string; hint: string }[] = [
  { id: "neural", label: "Neural Field", hint: "volumetric connectome" },
  { id: "atlas", label: "Atlas", hint: "isometric task-city" },
];

export function DirectionToggle() {
  const direction = usePraxisStore((s) => s.direction);
  const setDirection = usePraxisStore((s) => s.setDirection);

  return (
    <div className="dir-toggle pane" role="tablist" aria-label="visual direction">
      <span className="dir-kicker" aria-hidden>
        DIRECTION
      </span>
      <div className="dir-segs">
        {SEGMENTS.map((seg) => {
          const on = direction === seg.id;
          return (
            <button
              key={seg.id}
              role="tab"
              aria-selected={on}
              className={`dir-seg ${on ? "dir-on" : ""}`}
              onClick={() => setDirection(seg.id)}
              title={seg.hint}
            >
              {on && (
                <motion.span
                  layoutId="dir-pill"
                  className="dir-pill"
                  aria-hidden
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              )}
              <span className="dir-label">{seg.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
