/**
 * OperatorOverlay - the in-Praxis narration of a visible computer-use run.
 *
 * Mounts once in the MAIN (brain) window and listens for `operator:phase`
 * events from src-tauri/src/computer_use.rs. When Praxis starts driving the
 * desktop (auto-submitting into Codex Desktop, or a native open/focus fast
 * path) a top-center mission banner appears: the goal, a kinetic phase track
 * (launch → window → focus → inject → live), the autonomy level that unlocked
 * it, and an abort control. Auto-dismisses ~8s after handoff/completion;
 * hovering pins it open.
 *
 * Inert outside the Tauri shell - the listener import fails silently in a
 * plain browser, so dev views never see a dead overlay.
 */

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import "./operator.css";

type PhaseName =
  | "launching"
  | "waiting"
  | "focusing"
  | "pasting"
  | "submitted"
  | "handed-off"
  | "error";

interface PhaseEvent {
  phase: PhaseName;
  detail: string;
  goal: string;
  autonomy: string;
  mode: "codex" | "native";
  tsMs: number;
}

interface RunState {
  goal: string;
  autonomy: string;
  mode: "codex" | "native";
  events: PhaseEvent[];
}

const TERMINAL: ReadonlySet<PhaseName> = new Set(["submitted", "handed-off"]);

function isTerminal(events: PhaseEvent[]): boolean {
  if (events.length === 0) return false;
  if (events.some((e) => TERMINAL.has(e.phase))) return true;
  return events[events.length - 1].phase === "error";
}

/** The canonical codex journey; native runs collapse to two beats. */
const CODEX_TRACK: Array<{ key: PhaseName; label: string }> = [
  { key: "launching", label: "Launch" },
  { key: "waiting", label: "Window" },
  { key: "focusing", label: "Focus" },
  { key: "pasting", label: "Inject" },
  { key: "submitted", label: "Live" },
];

const NATIVE_TRACK: Array<{ key: PhaseName; label: string }> = [
  { key: "launching", label: "Native op" },
  { key: "submitted", label: "Done" },
];

type StepState = "done" | "active" | "error" | "pending" | "handed";

export function OperatorOverlay() {
  const [run, setRun] = useState<RunState | null>(null);
  const [hovered, setHovered] = useState(false);
  const [aborting, setAborting] = useState(false);

  // ── event intake ────────────────────────────────────────────────────────
  useEffect(() => {
    let off: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<PhaseEvent>("operator:phase", (e) => {
          const ev = e.payload;
          setRun((prev) => {
            // A goal-less event (abort broadcast) belongs to whatever run is showing.
            const fresh =
              !prev ||
              (ev.goal !== "" && ev.goal !== prev.goal) ||
              (ev.phase === "launching" && isTerminal(prev.events));
            if (fresh) {
              if (ev.goal === "") return prev; // stray abort with nothing on screen
              return { goal: ev.goal, autonomy: ev.autonomy, mode: ev.mode, events: [ev] };
            }
            return {
              ...prev,
              autonomy: ev.autonomy || prev.autonomy,
              mode: ev.mode ?? prev.mode,
              events: [...prev.events, ev],
            };
          });
        }),
      )
      .then((f) => {
        off = f;
      })
      .catch(() => {
        /* not inside the Tauri shell - overlay stays dormant */
      });
    return () => off?.();
  }, []);

  // new run → clear the abort latch
  useEffect(() => {
    setAborting(false);
  }, [run?.goal]);

  // ── auto-dismiss ~8s after terminal (hover pins it open) ───────────────
  const terminal = run ? isTerminal(run.events) : false;
  const eventCount = run?.events.length ?? 0;
  useEffect(() => {
    if (!run || !terminal || hovered) return;
    const t = window.setTimeout(() => setRun(null), 8000);
    return () => window.clearTimeout(t);
  }, [run, terminal, hovered, eventCount]);

  const abort = useCallback(() => {
    setAborting(true);
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("computer_use_abort_all"))
      .catch(() => {
        /* command missing / not in shell - nothing to stop */
      });
  }, []);

  // AnimatePresence must STAY mounted (card as conditional child) or the exit
  // spring never plays - an early `return null` here would hard-cut the banner.
  return (
    <AnimatePresence>
      {run && (
        <OperatorCard
          key={run.goal}
          run={run}
          terminal={terminal}
          hovered={hovered}
          aborting={aborting}
          onAbort={abort}
          onDismiss={() => setRun(null)}
          onHover={setHovered}
        />
      )}
    </AnimatePresence>
  );
}

function OperatorCard({
  run,
  terminal,
  hovered,
  aborting,
  onAbort,
  onDismiss,
  onHover,
}: {
  run: RunState;
  terminal: boolean;
  hovered: boolean;
  aborting: boolean;
  onAbort: () => void;
  onDismiss: () => void;
  onHover: (h: boolean) => void;
}) {
  const seen = new Set(run.events.map((e) => e.phase));
  const hasError = seen.has("error");
  const handedOff = seen.has("handed-off");
  const track = run.mode === "native" ? NATIVE_TRACK : CODEX_TRACK;
  const eventCount = run.events.length;

  let reached = 0;
  track.forEach((step, i) => {
    if (seen.has(step.key)) reached = i;
  });
  // handed-off / error land on the final beat so the track reads as resolved
  if (handedOff || (hasError && terminal)) reached = track.length - 1;

  const stepState = (i: number): StepState => {
    if (i < reached) return "done";
    if (i > reached) return "pending";
    if (hasError && !handedOff) return "error";
    if (handedOff) return "handed";
    if (terminal) return "done";
    return "active";
  };

  const last = run.events[eventCount - 1];
  const live = !terminal;
  const sigilState = hasError && !handedOff ? "error" : terminal ? "done" : "live";

  return (
    <motion.aside
      className="op-root"
      data-state={sigilState}
      initial={{ x: "-50%", y: -26, opacity: 0, scale: 0.96 }}
      animate={{ x: "-50%", y: 0, opacity: 1, scale: 1 }}
      exit={{ x: "-50%", y: -18, opacity: 0, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 380, damping: 32, mass: 0.9 }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      role="status"
      aria-live="polite"
    >
      <header className="op-head">
        <span className={`op-sigil is-${sigilState}`} aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <div className="op-title">
          <strong>Operator</strong>
          <span className="op-mode">
            {run.mode === "native" ? "native · instant" : "visible · codex"}
          </span>
        </div>
        <span className="op-autonomy" data-level={run.autonomy}>
          {run.autonomy}
        </span>
        {live && run.mode === "codex" ? (
          <button className="op-btn op-abort" onClick={onAbort} disabled={aborting}>
            {aborting ? "aborting…" : "abort"}
          </button>
        ) : (
          <button className="op-btn" onClick={onDismiss}>
            dismiss
          </button>
        )}
      </header>

      <p className="op-goal">“{run.goal}”</p>

      <ol className="op-track">
        {track.map((step, i) => {
          const state = stepState(i);
          const label = i === track.length - 1 && handedOff ? "Handed off" : step.label;
          return (
            <li key={step.key} className="op-step" data-state={state}>
              <span className="op-step-dot" aria-hidden>
                {state === "done" && <i className="op-step-check" />}
              </span>
              <span className="op-step-label">{label}</span>
              {i < track.length - 1 && <span className="op-step-line" aria-hidden />}
            </li>
          );
        })}
      </ol>

      <AnimatePresence mode="wait">
        <motion.p
          key={`${run.goal}:${eventCount}`}
          className="op-detail"
          data-phase={last.phase}
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.18 }}
        >
          {last.detail}
        </motion.p>
      </AnimatePresence>

      {terminal && !hovered && <span className="op-drain" key={`drain-${eventCount}`} aria-hidden />}
    </motion.aside>
  );
}
