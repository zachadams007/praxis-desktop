/**
 * DumpBox - MISSION, a two-way chat with Praxis (voice-UX restructure 2026-07-07;
 * rebuilt 2026-09-30 so Praxis can answer back).
 *
 * Atlas is who the owner talks to; PRAXIS runs the work - and this is where it speaks. The
 * panel is the live Mission thread (src/orchestrator/missionThread.ts):
 *
 *   header strip  the running mission - status, elapsed, step, who is working right now
 *   composer      the same input as ever: one prompt that SIMULTANEOUSLY
 *                   (a) FILES the plannable parts onto the journey (dump()),
 *                   (b) EXECUTES control commands and kicks off build/do goals
 *                       (orchestrate()),
 *                   (c) ANSWERS anything that reads as a question (ask()),
 *                 all fanned out by the store's submit() off a pure classifier
 *                 (src/orchestrator/submitClassify.ts). submit() posts the owner's message
 *                 into the thread; Praxis's replies arrive through it.
 *
 * When a new mission starts while the panel is closed it opens itself (without taking
 * keyboard focus); while closed, the dock shows what is running / unread / done
 * (Hud.tsx → DumpDock). Quick simple questions that should NOT spawn a mission live in the
 * separate "Atlas" fast surface (OrchestratorPanel.tsx → pure ask()).
 *
 * Anchored to the bottom-left DumpDock, opening UPWARD, in the Command-Center panel
 * language, with the same expand/collapse affordance as Atlas so the two capture
 * surfaces stay a consistent family.
 */

import "@/styles/mission.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { usePraxisStore, type WorkPart } from "@/store/usePraxisStore";
import { buildGraph } from "@/data/graph";
import { isVisible, onVisibilityChange } from "@/shared/visibility";
import { MissionStrip, MissionThread, useNow } from "@/components/mission/MissionThread";
import { requestMissionStop } from "@/orchestrator/missionControl";
import {
  WINDOW_START,
  clearFinishedMissions,
  consumeQuietOpen,
  markSeen,
  reloadFeed,
  restoreClearedMissions,
  useMissionGroups,
} from "@/components/mission/missionFeed";
import { missionPhase, missionView, stripMission } from "@/components/mission/missionLogic";

/** Shared expand/collapse glyph - identical to Atlas's, so the two bottom-left
 *  capture panels read as one family. */
function ExpandIcon({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M10 6L14 2M14 2H10.5M14 2V5.5M6 10L2 14M2 14H5.5M2 14V10.5"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M9 7L14 2M14 2H10M14 2V6M7 9L2 14M2 14H6M2 14V10"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Live window size so the expand animates between REAL pixel targets (motion can't
 *  tween min()/calc() strings - same reason Atlas uses numbers). */
/** Live width of the open Atlas panel (`.orch2`), 0 while it's closed. Mission uses it to
 *  sit beside Atlas instead of on top of it. Gives up after ~1s if Atlas never mounts. */
function useAtlasPanelWidth(): number {
  const chatOpen = usePraxisStore((s) => s.chatOpen);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!chatOpen) {
      setW(0);
      return;
    }
    let ro: ResizeObserver | null = null;
    let raf = 0;
    let tries = 0;
    const attach = () => {
      const el = document.querySelector<HTMLElement>(".orch2");
      if (!el) {
        if (++tries < 60) raf = requestAnimationFrame(attach);
        return;
      }
      const measure = () => setW(Math.round(el.getBoundingClientRect().width));
      measure();
      ro = new ResizeObserver(measure);
      ro.observe(el);
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [chatOpen]);
  return w;
}

function useWindowSize() {
  const [size, setSize] = useState(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 1920,
    h: typeof window !== "undefined" ? window.innerHeight : 1080,
  }));
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}

/** Is the window actually on screen? (An open panel on a minimized window has seen nothing.) */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(isVisible);
  useEffect(() => onVisibilityChange(setVisible), []);
  return visible;
}

/** Small status glyph per work-order part state. */
function PartMark({ status }: { status: WorkPart["status"] }) {
  if (status === "done")
    return (
      <svg className="wo-mark done" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (status === "failed")
    return (
      <svg className="wo-mark failed" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  // running - a spinner ring
  return <span className="wo-mark running" aria-hidden />;
}

const KIND_LABEL: Record<WorkPart["kind"], string> = {
  file: "FILE",
  command: "DO",
  goal: "BUILD",
  answer: "ASK",
};

export function DumpBox() {
  const open = usePraxisStore((s) => s.dumpOpen);
  const graphVersion = usePraxisStore((s) => s.graphVersion);
  const workOrder = usePraxisStore((s) => s.workOrder);
  const { feed, groups } = useMissionGroups();
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Six-second Undo after the owner clears finished missions (same pattern as the Inbox).
  const [cleared, setCleared] = useState<{ previous: number; hidden: number } | null>(null);
  useEffect(() => {
    if (!cleared) return;
    const t = window.setTimeout(() => setCleared(null), 6000);
    return () => window.clearTimeout(t);
  }, [cleared]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { w: winW, h: winH } = useWindowSize();
  const visible = usePageVisible();
  useNow(open, 30_000); // keeps "a finished mission lingers in the strip for 15 min" honest

  // real pixel targets - mirrors Atlas's dims so the two panels grow the same
  // way from the same corner (collapsed compact; expanded diagonal up-and-right).
  // Compact grows once there is a conversation (or a submitted checklist) to hold:
  // numbers tween, "auto" doesn't.
  const roomy = groups.length > 0 || !!workOrder;
  const atlasW = useAtlasPanelWidth();
  const besideLeft = atlasW > 0 ? 16 + atlasW + 12 : 16;
  const room = winW - besideLeft - 16;
  const left = atlasW > 0 && room >= 340 ? besideLeft : 16;
  const maxW = winW - left - 16;
  const dims = expanded
    ? { width: Math.min(Math.round(winW * 0.6), 820, maxW), height: Math.min(winH - 132, 640) }
    : { width: Math.min(460, maxW), height: Math.min(roomy ? 480 : 318, winH - 140) };

  useEffect(() => {
    if (open) {
      // A mission that opened the panel by itself must not pull keyboard focus away from
      // wherever the owner is typing; only a deliberate open focuses the composer.
      if (consumeQuietOpen()) return;
      // focus after the enter animation starts so the caret is ready
      const id = window.setTimeout(() => inputRef.current?.focus(), 60);
      return () => window.clearTimeout(id);
    }
    setExpanded(false); // always reopen compact
  }, [open]);

  // Everything in the thread counts as seen while the panel is open and on screen: that
  // is what clears the dock's unread badge and its "done" glow.
  useEffect(() => {
    if (open && visible && feed.loaded) markSeen();
  }, [open, visible, feed.loaded, feed.msgs]);

  // mission completion: all parts done/failed → the prompt's contract is closed.
  const allSettled =
    !!workOrder && workOrder.parts.length > 0 && workOrder.parts.every((p) => p.status !== "running");
  const anyRunning = !!workOrder && workOrder.parts.some((p) => p.status === "running");

  const strip = open ? stripMission(groups, Date.now(), WINDOW_START) : null;
  const stripPhase = missionPhase(groups.find((g) => g.missionId === strip?.missionId)?.msgs ?? []);

  const submit = async () => {
    const v = text.trim();
    if (v.length < 2 || busy) return;
    setBusy(true);
    setSendError(null);
    const st = usePraxisStore.getState();
    // clear any prior settled order so a new submit starts clean
    if (st.workOrder && st.workOrder.parts.every((p) => p.status !== "running")) st.clearWorkOrder();
    // submit() posts the message into the thread at once, so the field frees up now - and
    // if it throws before registering anything, the words come straight back.
    setText("");
    try {
      await st.submit(v);
    } catch (err) {
      setText(v);
      setSendError(err instanceof Error ? err.message : "That didn't send — try again.");
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const areas = useMemo(
    () => buildGraph().nodes.filter((n) => n.tier === 1).map((n) => n.label),
    [graphVersion],
  );

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={`dump ms ${expanded ? "is-expanded" : ""}`}
          role="region"
          aria-label="Mission — a chat with Praxis"
          initial={{ opacity: 0, y: 12, left, width: dims.width, height: dims.height }}
          animate={{ opacity: 1, y: 0, left, width: dims.width, height: dims.height }}
          exit={{ opacity: 0, y: 10 }}
          transition={{
            opacity: { duration: 0.18 },
            y: { type: "spring", stiffness: 380, damping: 32 },
            left: { duration: 0.4, ease: [0.22, 1, 0.36, 1] },
            width: { duration: 0.4, ease: [0.22, 1, 0.36, 1] },
            height: { duration: 0.4, ease: [0.22, 1, 0.36, 1] },
          }}
          style={{ transformOrigin: "bottom left" }}
        >
          <header className="dump-head">
            <span className="px-tick" aria-hidden />
            <span className="dump-title">Mission</span>
            <span className="dump-sub">Praxis runs the work · it tells you when it's done</span>
            <div className="dump-headbtns">
              {groups.some((g) => missionView(g, WINDOW_START).status !== "running") && (
                <button
                  className="dump-iconbtn"
                  onClick={() => setCleared(clearFinishedMissions())}
                  aria-label="Clear finished missions"
                  title="Clear finished missions (running ones stay) — you can undo"
                >
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden>
                    <path
                      d="M2.75 4.5h10.5M6.25 4.5V3.1h3.5v1.4M4.4 4.5l.62 8.4h5.96l.62-8.4"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
              <button
                className="dump-iconbtn"
                onClick={() => setExpanded((v) => !v)}
                aria-label={expanded ? "Collapse Mission" : "Expand Mission"}
                title={expanded ? "Collapse" : "Expand"}
              >
                <ExpandIcon expanded={expanded} />
              </button>
              <button
                className="dump-iconbtn"
                onClick={() => usePraxisStore.getState().setDumpOpen(false)}
                aria-label="Close Mission"
                title="Close"
              >
                <svg viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path d="M3 3L13 13M13 3L3 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </header>

          {cleared && (
            <p className="ms-undo" role="status">
              {cleared.hidden === 1 ? "Cleared 1 finished mission." : `Cleared ${cleared.hidden} finished missions.`}{" "}
              <button
                type="button"
                className="ms-undo-btn"
                onClick={() => {
                  restoreClearedMissions(cleared.previous);
                  setCleared(null);
                }}
              >
                UNDO
              </button>
            </p>
          )}

          {/* the running mission: status · elapsed · step · who is working this second */}
          {strip && (
            <MissionStrip
              view={strip}
              phase={stripPhase}
              onStop={() => void requestMissionStop(strip.missionId)}
              onRetry={() => {
                const asked = groups.find((g) => g.missionId === strip.missionId)?.msgs.find((m) => m.kind === "mission")?.text;
                if (asked?.trim()) void usePraxisStore.getState().submit(asked.trim());
              }}
            />
          )}

          <MissionThread
            groups={groups}
            loaded={feed.loaded}
            error={feed.error}
            onRetry={reloadFeed}
            windowStart={WINDOW_START}
            open={open}
            expanded={expanded}
            headedBy={strip ? strip.missionId : null}
          />

          {/* the submitted prompt's parts - a persistent checklist that outlives the submit */}
          <AnimatePresence initial={false}>
            {workOrder && (
              <motion.section
                className="wo wo-compact"
                aria-label="What your last message set in motion"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="wo-head">
                  <span className={`wo-status ${allSettled ? "settled" : "live"}`}>
                    {anyRunning ? "in progress" : allSettled ? "complete" : "queued"}
                  </span>
                  <p className="wo-prompt" title={workOrder.text}>{workOrder.text}</p>
                  {allSettled && (
                    <button
                      className="wo-clear"
                      onClick={() => usePraxisStore.getState().clearWorkOrder()}
                      title="Clear this mission"
                    >
                      clear
                    </button>
                  )}
                </div>
                <ul className="wo-parts">
                  {workOrder.parts.map((p) => (
                    <li key={p.id} className={`wo-part is-${p.status}`} title={p.detail || p.label}>
                      <PartMark status={p.status} />
                      <span className="wo-kind">{KIND_LABEL[p.kind]}</span>
                      <span className="wo-label">{p.label}</span>
                    </li>
                  ))}
                </ul>
              </motion.section>
            )}
          </AnimatePresence>

          <div className="ms-composer">
            <textarea
              ref={inputRef}
              className="dump-input"
              rows={3}
              value={text}
              aria-label="Message Praxis"
              placeholder={
                "one input — files it, does it, builds it, answers it\n“research broker APIs next week; build the quad tile layout; what shipped in Catalyzed?”"
              }
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
            />
            {sendError && (
              <p className="ms-send-error" role="alert">
                {sendError}
              </p>
            )}
            <footer className="dump-foot">
              <span className="dim dump-routes" title={`files by keyword → ${areas.join(" · ")}`}>
                one prompt · fans out to every faculty it fits
              </span>
              <button className="dump-go" onClick={() => void submit()} disabled={busy || text.trim().length < 2}>
                {busy ? "routing…" : "submit ↵"}
              </button>
            </footer>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
