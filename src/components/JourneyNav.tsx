/**
 * JourneyNav - the on-screen transport for the time-corridor (journey mode only).
 *
 * Makes the three navigation axes visible and clickable so they aren't a hidden
 * keyboard secret, and so the semantics are unmistakable:
 *
 *   TIME  ◀ ▶   sweep through the whole roadmap - past ↔ now ↔ future
 *   AREA  ▲ ▼   switch which initiative lane you're looking at
 *   TASK  ◀ ▶   step milestone-to-milestone inside the focused lane
 *
 * Each control mirrors its keyboard verb (←/→, ↑/↓, [ / ]) and shows a live
 * readout of where you are, so the journey is something you can SEE yourself
 * moving through, not guess at.
 */

import { useMemo, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { usePraxisStore } from "@/store/usePraxisStore";
import { buildGraph } from "@/data/graph";
import { journeyMaxSlot, journeyMinSlot, NOW_SLOT } from "@/data/journeyLayout";

type Dir = "left" | "right" | "up" | "down";
const ROT: Record<Dir, number> = { right: 0, down: 90, left: 180, up: 270 };

function Chevron({ dir }: { dir: Dir }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      style={{ transform: `rotate(${ROT[dir]}deg)` }}
      aria-hidden
    >
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function JourneyNav() {
  const viewMode = usePraxisStore((s) => s.viewMode);
  return (
    <AnimatePresence>{viewMode === "journey" && <JourneyNavBar key="jnav" />}</AnimatePresence>
  );
}

function JourneyNavBar() {
  const journey = usePraxisStore((s) => s.journey);
  const timeCol = usePraxisStore((s) => s.journeyTimeCol);
  const areaId = usePraxisStore((s) => s.journeyAreaId);
  const cursorId = usePraxisStore((s) => s.journeyCursorId);
  const graphVersion = usePraxisStore((s) => s.graphVersion);
  const g = useMemo(() => buildGraph(), [graphVersion]);

  const scrubTime = usePraxisStore((s) => s.scrubTime);
  const switchArea = usePraxisStore((s) => s.switchArea);
  const hopTask = usePraxisStore((s) => s.hopTask);

  const minSlot = journeyMinSlot(journey);
  const maxSlot = journeyMaxSlot(journey);

  let phase: "idle" | "past" | "now" | "future" = "idle";
  let timeText = "now";
  if (timeCol != null) {
    if (timeCol < NOW_SLOT) {
      phase = "past";
      timeText = `the past · −${NOW_SLOT - timeCol}`;
    } else if (timeCol > NOW_SLOT) {
      phase = "future";
      timeText = `ahead · +${timeCol - NOW_SLOT}`;
    } else {
      phase = "now";
      timeText = "now";
    }
  }

  const areaText = areaId ? g.byId.get(areaId)?.label ?? areaId : "all areas";
  const taskText = cursorId ? journey.find((m) => m.id === cursorId)?.label ?? "—" : "—";

  const atPast = (timeCol ?? NOW_SLOT) <= minSlot;
  const atFuture = (timeCol ?? NOW_SLOT) >= maxSlot;

  return (
    <motion.div
      className="jnav"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 14 }}
      transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
      role="group"
      aria-label="journey navigation"
    >
      <Group cap="Time" hint="← →">
        <button
          className="jnav-btn"
          onClick={() => scrubTime(-1)}
          disabled={atPast}
          aria-label="back in time"
          title="back in time"
        >
          <Chevron dir="left" />
        </button>
        <span className={`jnav-read phase-${phase}`}>{timeText}</span>
        <button
          className="jnav-btn"
          onClick={() => scrubTime(1)}
          disabled={atFuture}
          aria-label="forward in time"
          title="forward in time"
        >
          <Chevron dir="right" />
        </button>
      </Group>

      <span className="jnav-sep" aria-hidden />

      <Group cap="Area" hint="↑ ↓">
        <button className="jnav-btn" onClick={() => switchArea(-1)} aria-label="previous area" title="previous area">
          <Chevron dir="up" />
        </button>
        <span className={`jnav-read ${areaId ? "is-set" : ""}`}>{areaText}</span>
        <button className="jnav-btn" onClick={() => switchArea(1)} aria-label="next area" title="next area">
          <Chevron dir="down" />
        </button>
      </Group>

      <span className="jnav-sep" aria-hidden />

      <Group cap="Task" hint="[ ]">
        <button className="jnav-btn" onClick={() => hopTask(-1)} aria-label="previous task" title="previous task">
          <Chevron dir="left" />
        </button>
        <span className={`jnav-read ${cursorId ? "is-set" : ""}`}>{taskText}</span>
        <button className="jnav-btn" onClick={() => hopTask(1)} aria-label="next task" title="next task">
          <Chevron dir="right" />
        </button>
      </Group>
    </motion.div>
  );
}

function Group({ cap, hint, children }: { cap: string; hint: string; children: ReactNode }) {
  return (
    <div className="jnav-group">
      <div className="jnav-cap">
        <span>{cap}</span>
        <kbd className="jnav-kbd">{hint}</kbd>
      </div>
      <div className="jnav-row">{children}</div>
    </div>
  );
}
