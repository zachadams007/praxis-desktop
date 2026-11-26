/**
 * StateBar - the bottom instrument strip (brain-window v2, spec item 9):
 *
 *   [ STATE + serif status line | live voice waveform | live stats + latest event ]
 *
 * Every field is REAL - and now honestly so: the store's applyEvent gates decorative
 * mock events (`synthetic`) OUT of the roster / tasks / ticker / feed it reads (spec
 * §A.2), so these fields go quiet the instant no real work is live instead of echoing
 * the ambient mock timeline.
 *   STATE     HALTED (halt breaker) → LISTENING (mic actually armed) → SPEAKING
 *             (audio actually playing) → EXECUTING (REAL agents genuinely working;
 *             synthetic filler no longer counts) → READY.
 *   sub-line  the live agent-thought ticker when a REAL one is firing, else the
 *             honest system line (halted / nominal).
 *   waveform  see Waveform.tsx - mic amplitude / speech envelope / real activity.
 *   stats     firing agents · active tasks, straight off the store (real-only).
 *   event     the newest feed item; clicking flies the camera to it.
 */

import { useEffect, useState } from "react";
import { usePraxisStore } from "@/store/usePraxisStore";
import { useFiringAgents } from "@/shared/agents";
import { Glyph } from "@/glyphs/glyphs";
import { useHalt } from "@/command/haltStore";
import { cancelSpeech, isSpeaking, onSpeakingChange } from "@/voice/speak";
import { publishPraxisStatus, type PraxisStatusState } from "@/shared/praxisStatus";
import { Waveform } from "./Waveform";

type PraxisState = "halted" | "listening" | "speaking" | "executing" | "observing";

const STATE_LABEL: Record<PraxisState, string> = {
  halted: "HALTED",
  listening: "LISTENING",
  speaking: "SPEAKING",
  executing: "EXECUTING",
  observing: "READY",
};

export function StateBar() {
  const tasks = usePraxisStore((s) => s.tasks);
  const feed = usePraxisStore((s) => s.feed);
  const ticker = usePraxisStore((s) => s.ticker);
  const listening = usePraxisStore((s) => s.voiceListening);
  const { halted } = useHalt();

  // mirror speak.ts's "audio actually playing" flag into React state
  const [speaking, setSpeaking] = useState(isSpeaking);
  useEffect(() => onSpeakingChange(setSpeaking), []);

  // ONE-TRUTH firing count: the SAME fd_sessions roster the Galaxy/Command Center/
  // Flight Deck read (useFiringAgents), NOT the event bus - so this number can never
  // disagree with the other windows. Real coding sessions only; the infra engine and
  // parked (≥30 min silent) sessions are already excluded upstream.
  const firing = useFiringAgents().length;
  const activeTasks = Object.values(tasks).filter((t) => t.active).length;

  const state: PraxisState = halted
    ? "halted"
    : listening
      ? "listening"
      : speaking
        ? "speaking"
        : firing > 0 || activeTasks > 0
          ? "executing"
          : "observing";

  const statusState: PraxisStatusState =
    state === "observing" || state === "halted" ? "idle" : state;
  const statusDetail = halted
    ? "halted"
    : listening
      ? "listening for you"
      : speaking
        ? "Praxis is speaking"
        : firing > 0
          ? `${firing} agent${firing === 1 ? "" : "s"} at work`
          : activeTasks > 0
            ? `${activeTasks} active task${activeTasks === 1 ? "" : "s"}`
          : "all systems nominal";
  useEffect(() => {
    void publishPraxisStatus({ state: statusState, detail: statusDetail });
  }, [statusState, statusDetail]);

  // the serif whisper: a real thought when one is live, else the honest system line
  const sub = halted
    ? "halted — nothing new starts until you resume"
    : ticker
      ? `${ticker.name} — “${ticker.thought}”`
      : listening
        ? "listening for you…"
        : firing > 0
          ? `${firing} agent${firing === 1 ? "" : "s"} at work`
          : activeTasks > 0
            ? `${activeTasks} active task${activeTasks === 1 ? "" : "s"}`
          : "all systems nominal — hold T to talk";

  const latest = feed[0];

  return (
    <div className="sbar pane" data-state={state} role="status" aria-label="praxis state">
      <div className="sbar-state">
        <span className="sbar-state-label">
          <span className="s-dot" aria-hidden />
          {STATE_LABEL[state]}
        </span>
        <span className="sbar-state-sub" title={sub}>
          {sub}
        </span>
      </div>

      {/* the waveform doubles as the mouse barge-in: click it while Praxis is
          talking to cut the voice (Ctrl+T / Esc remain the keyboard interrupts) */}
      <div
        className={`sbar-wave ${speaking ? "can-stop" : ""}`}
        onClick={() => speaking && cancelSpeech()}
        title={speaking ? "click to interrupt Praxis (Ctrl+T / Esc also work)" : undefined}
        role={speaking ? "button" : undefined}
        aria-label={speaking ? "stop Praxis talking" : undefined}
      >
        <Waveform />
      </div>

      <div className="sbar-stats">
        <span className="sbar-stat" title="agents firing right now">
          <span className="k">AGENTS</span>
          <span className={`v ${halted ? "cut" : firing > 0 ? "live" : ""}`}>
            {halted ? "HALTED" : `${firing} FIRING`}
          </span>
        </span>
        <span className="sbar-stat" title="tasks currently active">
          <span className="k">TASKS</span>
          <span className={`v ${activeTasks > 0 ? "hot" : ""}`}>{activeTasks} ACTIVE</span>
        </span>
        {latest && (
          <button
            key={latest.id}
            className="sbar-event"
            style={
              latest.areaId
                ? ({ "--g": `var(--area-${latest.areaId})` } as React.CSSProperties)
                : undefined
            }
            onClick={() => {
              const ref = latest.refId;
              if (!ref) return;
              // A real file birth carries a synthetic id ("real:<path>") with no 3D
              // node behind it. focus() on that moved the camera nowhere AND blanked
              // the Inspector (DetailCard returns null for an id the graph map does
              // not hold) - clicking the HUD's most prominent "something happened"
              // affordance broke the dock. Open the file instead, which is what a
              // file cell should do anyway.
              if (ref.startsWith("real:")) {
                const path = ref.slice(5);
                void import("@tauri-apps/api/core")
                  .then(({ invoke }) => invoke("open_memory_file", { path, slug: null }))
                  .catch(() => {});
                return;
              }
              usePraxisStore.getState().focus(ref);
            }}
            disabled={!latest.refId}
            title={
              latest.refId
                ? latest.refId.startsWith("real:")
                  ? "open it"
                  : "fly to it"
                : undefined
            }
          >
            <Glyph id={latest.glyph} size={11} className="cell-glyph" />
            <span className="cell-text">{latest.text}</span>
          </button>
        )}
      </div>
    </div>
  );
}
