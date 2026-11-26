/**
 * MissionThread - the transcript of the Mission chat, and the header strip above it.
 *
 *   • older finished missions fold down to their header + final card (click to unfold),
 *   • real empty / error / loading states - never invented content,
 *   • `role="log"` + `aria-live="polite"`: new Praxis messages are announced.
 *
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { visibleInterval } from "@/shared/visibility";
import {
  type MissionGroup,
  type MissionPhase,
  type MissionView,
  agentName,
  elapsedMs,
  fmtElapsed,
  missionView,
  whenLabel,
} from "./missionLogic";
import { AgentMark, MissionMessage, UnpinContext, agentTint } from "./MissionMessages";

/** Re-render once a second while `active` (and the window is visible) - for live elapsed times. */
export function useNow(active: boolean, ms = 1000): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    return visibleInterval(() => setTick((t) => t + 1), ms);
  }, [active, ms]);
  return Date.now();
}

const STATUS_WORD: Record<MissionView["status"], string> = {
  running: "running",
  done: "done",
  failed: "failed",
  interrupted: "interrupted",
};

function StatusMark({ status }: { status: MissionView["status"] }) {
  if (status === "running") return <i className="ms-spin" aria-hidden />;
  if (status === "done") {
    return (
      <svg viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  return <i className="ms-dot" aria-hidden />;
}

// -------------------------------------------------------------- header strip ---

const PHASE_WORDS: Record<MissionPhase, string> = {
  planning: "planning the work",
  starting: "plan is set — starting the first step",
  between: "between steps — no agent is mid-task",
};

export function MissionStrip({
  view,
  phase,
  onStop,
  onRetry,
}: {
  view: MissionView;
  phase: MissionPhase;
  /** Stop this mission (missionControl.requestMissionStop). Shown while it runs. */
  onStop?: () => void;
  /** Run the same request again. Shown after a failure or an interruption. */
  onRetry?: () => void;
}) {
  const running = view.status === "running";
  const now = useNow(running);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);
  return (
    <div className={`ms-strip is-${view.status}`} role="group" aria-label={`Current mission: ${view.title}`}>
      <div className="ms-strip-row">
        <span className={`ms-pill is-${view.status}`}>
          <StatusMark status={view.status} />
          {view.stopped ? "stopped" : STATUS_WORD[view.status]}
        </span>
        <span className="ms-strip-title" title={view.title}>
          {view.title}
        </span>
        {view.step && (
          <span className="ms-strip-step" title={`step ${view.step.index} of ${view.step.of}`}>
            {view.step.index}/{view.step.of}
          </span>
        )}
        <span className="ms-strip-time" aria-label="elapsed time">
          {fmtElapsed(elapsedMs(view, now))}
        </span>
        {running && onStop && (
          <button
            type="button"
            className="ms-strip-act is-stop"
            disabled={stopping}
            aria-label="Stop this mission"
            title="Stop this mission — its agents stop working; files they already wrote stay"
            onClick={() => {
              setStopping(true);
              onStop();
            }}
          >
            {stopping ? "STOPPING…" : "STOP"}
          </button>
        )}
        {!running && (view.status === "failed" || view.status === "interrupted") && onRetry && (
          <button type="button" className="ms-strip-act" aria-label="Run this mission again" title="Run the same request again" onClick={onRetry}>
            RETRY
          </button>
        )}
      </div>
      {running && (
        <div className="ms-strip-agents">
          {view.agents.length > 0 ? (
            <>
              <span className="ms-strip-label">working now</span>
              {view.agents.map((a) => (
                <span
                  key={a.agent}
                  className="ms-chip"
                  style={{ "--m": agentTint(a.agent) } as React.CSSProperties}
                  title={[a.model, a.step ? `step ${a.step.index} of ${a.step.of}` : ""].filter(Boolean).join(" · ") || undefined}
                >
                  <AgentMark agent={a.agent} size={12} />
                  {agentName(a.agent)}
                  <i className="ms-pulse" aria-hidden />
                </span>
              ))}
            </>
          ) : (
            <span className="ms-strip-whisper">{PHASE_WORDS[phase]}</span>
          )}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------- group head ---

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`ms-chev${open ? " is-open" : ""}`} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M4 6.2L8 10l4-3.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const GroupHead = memo(function GroupHead({
  view,
  collapsed,
  hidden,
  onToggle,
}: {
  view: MissionView;
  collapsed: boolean;
  /** How many of its messages are folded away. */
  hidden: number;
  onToggle: () => void;
}) {
  const now = useNow(view.status === "running");
  const dur = fmtElapsed(elapsedMs(view, now));
  return (
    <button
      type="button"
      className={`ms-gh is-${view.status}`}
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={collapsed ? "show this mission's messages" : "fold this mission"}
    >
      <span className="ms-gh-tick" aria-hidden />
      <span className="ms-gh-title">{view.title}</span>
      <span className="ms-gh-meta">
        {collapsed && hidden > 0 && <span>{hidden} hidden · </span>}
        <span className="ms-gh-status">{view.stopped ? "stopped" : STATUS_WORD[view.status]}</span> · {dur} · {whenLabel(view.startedAt, Date.now())}
      </span>
      <Chevron open={!collapsed} />
    </button>
  );
});

// ------------------------------------------------------------------- thread ---

export interface MissionThreadProps {
  groups: MissionGroup[];
  loaded: boolean;
  error: string | null;
  onRetry: () => void;
  /** When this window started - a "running" mission from before it reads as interrupted. */
  windowStart: number;
  /** Panel state: a change re-pins the view to the newest message when it was following it. */
  open: boolean;
  expanded: boolean;
  /** The mission the header strip already names - its own group head would just repeat it. */
  headedBy: string | null;
}

/** Older finished missions fold by default; the latest two and anything running stay open. */
const KEEP_OPEN = 2;
const NEAR_BOTTOM_PX = 48;

export function MissionThread({ groups, loaded, error, onRetry, windowStart, open, expanded, headedBy }: MissionThreadProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [missed, setMissed] = useState(0);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [ready, setReady] = useState(false);
  // Whether a mission starts folded is decided ONCE, when the panel first sees it - a newer
  // mission arriving must not fold the one the owner is reading out from under him.
  const startsFolded = useRef(new Map<string, boolean>());

  const views = useMemo(() => groups.map((g) => missionView(g, windowStart)), [groups, windowStart]);
  const total = useMemo(() => groups.reduce((n, g) => n + g.msgs.length, 0), [groups]);

  // Which messages are "new since the panel opened" (they ease in once).
  const known = useRef<Set<string> | null>(null);
  const isFresh = (id: string) => known.current !== null && !known.current.has(id);
  useEffect(() => {
    if (!loaded) return;
    if (known.current === null) known.current = new Set();
    for (const g of groups) for (const m of g.msgs) known.current.add(m.id);
  }, [groups, loaded]);

  // Announce additions politely - but not the whole thread the moment the panel opens.
  useEffect(() => {
    const id = window.setTimeout(() => setReady(true), 400);
    return () => window.clearTimeout(id);
  }, []);

  const toBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Follow the newest message - only while the owner is already at the bottom. (An instant
  // scrollTop, not behavior:"smooth": a smooth scroll inside the panel's animating
  // transform is dropped by Chromium - see OrchestratorPanel.)
  const prevTotal = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!loaded) return;
    if (prevTotal.current === null) {
      prevTotal.current = total;
      pinned.current = true;
      toBottom();
      return;
    }
    const added = total - prevTotal.current;
    prevTotal.current = total;
    if (pinned.current) toBottom();
    else if (added > 0) setMissed((n) => n + added);
  }, [total, loaded, toBottom]);

  // The panel opening / expanding resizes this list while it animates; stay on the newest.
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (pinned.current) toBottom();
  }, [open, expanded, toBottom]);

  const unpin = useCallback(() => {
    pinned.current = false;
    setAtBottom(false);
  }, []);

  const jump = () => {
    toBottom();
    pinned.current = true;
    setAtBottom(true);
    setMissed(0);
  };

  return (
    <div className="ms-thread-wrap">
      <UnpinContext.Provider value={unpin}>
        <div
          ref={listRef}
          className="ms-thread"
          role="log"
          aria-label="Mission thread with Praxis"
          aria-live={ready ? "polite" : "off"}
          aria-relevant="additions"
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget;
            const near = el.scrollHeight - el.clientHeight - el.scrollTop < NEAR_BOTTOM_PX;
            pinned.current = near;
            setAtBottom(near);
            if (near) setMissed(0);
          }}
        >
          {!loaded && <p className="ms-loading">reading the thread…</p>}

          {loaded && error && (
            <div className="ms-error" role="alert">
              <p>
                <b>Couldn't read the Mission thread.</b> {error}
              </p>
              <p className="ms-error-sub">New messages will still appear here as they arrive.</p>
              <button type="button" className="ms-retry" onClick={onRetry}>
                try again
              </button>
            </div>
          )}

          {loaded && !error && groups.length === 0 && (
            <div className="ms-empty">
              <span className="ms-empty-kicker">no missions yet</span>
              <p>Hand Praxis something to build, file or answer.</p>
              <span className="ms-empty-sub">
                Its plan, who's working, and how to open the finished work will show up here.
              </span>
            </div>
          )}

          {groups.map((g, gi) => {
            const view = views[gi];
            let initial = startsFolded.current.get(g.missionId);
            if (initial === undefined) {
              initial = gi < groups.length - KEEP_OPEN && view.status !== "running";
              startsFolded.current.set(g.missionId, initial);
            }
            const folded = toggled[g.missionId] ?? initial;
            // a folded mission keeps its last word: what it delivered, why it stopped, or the answer
            const closing = folded
              ? [...g.msgs].reverse().find((m) => m.kind === "result" || m.kind === "failure" || m.kind === "answer")
              : undefined;
            const shown = folded ? (closing ? [closing] : []) : g.msgs;
            return (
              <div key={g.missionId} className={`ms-group is-${view.status}`} role="group" aria-label={`Mission: ${g.title}`}>
                {/* the first mission under the header strip needs no second title */}
                {!(gi === 0 && g.missionId === headedBy) && (
                  <GroupHead
                    view={view}
                    collapsed={folded}
                    hidden={g.msgs.length - shown.length}
                    onToggle={() => setToggled((t) => ({ ...t, [g.missionId]: !folded }))}
                  />
                )}
                {shown.map((m) => (
                  <MissionMessage key={m.id} m={m} fresh={isFresh(m.id)} live={view.liveDispatchIds.has(m.id)} />
                ))}
              </div>
            );
          })}
        </div>
      </UnpinContext.Provider>

      {!atBottom && missed > 0 && (
        <button type="button" className="ms-jump" onClick={jump}>
          <svg viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M8 3v9M4 8.5L8 12.5l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>jump to latest</span>
          <b>{missed} new</b>
        </button>
      )}
    </div>
  );
}
