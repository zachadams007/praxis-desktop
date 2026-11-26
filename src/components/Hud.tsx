/**
 * Hud - the 2D instrument chrome around the sacred center (round3-remodel-lock
 * R14), rebuilt 2026-07-05 to the Command Center / Memory Galaxy language:
 *
 *   top-left   BrandBlock - PRAXIS wordmark · trust pill · version · live clock ·
 *              executing/firing line (every stat real)
 *   top-center LauncherDock - the other windows (voice chip retired: keyboard is
 *              the primary talk trigger; a backup Talk lives in the dock CONTROLS)
 *   left       vertical glyph RAIL - overview + N areas + history toggle
 *   bottom     StateBar - state label · live waveform · live stats (StateBar.tsx)
 *   bottom-l   DumpDock - dump-a-thought (Mission) + Atlas opens up from it
 *
 * The right dock (inspector ⇄ inbox ⇄ controls) lives in RightDock.tsx.
 * Everything is thin translucent glass - nothing opaque ever crosses the brain.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { invoke } from "@tauri-apps/api/core";
import { usePraxisStore, observedMilestoneIds } from "@/store/usePraxisStore";
import { AUTHORED_MILESTONES, ROADMAP_AUTHORED_AT } from "@/data/journey";
import { useFiringAgents } from "@/shared/agents";
import { buildGraph } from "@/data/graph";
import { Glyph, AREA_GLYPH } from "@/glyphs/glyphs";
import { TRUST_LEVELS } from "@/shared/autonomy";
import { voiceHoldEnd, voiceHoldStart } from "@/voice/voiceEvents";
import { useHalt } from "@/command/haltStore";
import { useMissionDock } from "./mission/missionFeed";
import { JourneyNav } from "./JourneyNav";
import { StateBar } from "./StateBar";

/** Open a secondary super-app window via its Rust command. A plain browser has no
 *  Tauri bridge - that case is silent; any OTHER failure is surfaced (so a stale
 *  binary / dead dev server isn't an invisible no-op). */
function openWindow(cmd: string, name: string) {
  const tauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
  if (!tauri) return; // running in a plain browser - nothing to open
  invoke(cmd).catch((err) => {
    console.error(`[${name}] open failed:`, err);
    usePraxisStore
      .getState()
      .notify(`${name} didn't open — see console (dev server may be down)`);
  });
}
const openFlightDeck = () => openWindow("open_flight_deck_cmd", "Flight Deck");
const openCommandCenter = () => openWindow("open_command_center_cmd", "Command Center");
const openMemoryGalaxy = () => openWindow("open_knowledge_cmd", "Memory Galaxy");

export function Hud() {
  return (
    <>
      <BrandBlock />
      <LauncherDock />
      <JourneyModeBanner />
      <LeftRail />
      <JourneyNav />
      <StateBar />
      <DumpDock />
      <NavHints />
    </>
  );
}

/* ------------------------------------------------------ journey mode banner --- */

/**
 * JourneyModeBanner - the unmistakable "you switched modes" cue (fix 2026-07-10:
 * the JOURNEY button + J key DID morph the brain into the roadmap tree, but the
 * transition was subtle enough that a user/auditor couldn't tell it engaged). It
 * renders NOTHING in brain mode - so the DoF brain look is byte-identical at rest -
 * and slides a premium top-center label in the instant viewMode flips to "journey".
 * The "press J for brain" affordance is a real button (clicking it toggles back), so
 * the indicator both TELLS you the mode and gets you out of it.
 */
function JourneyModeBanner() {
  const viewMode = usePraxisStore((s) => s.viewMode);
  // Say what this view actually is. The corridor renders a hand-authored roadmap
  // whose statuses only move when a live session keyword-matches a milestone, so
  // presenting it bare as "the roadmap tree" reads as tracked status. Naming the
  // authored date and how many milestones REAL work has moved keeps it a plan.
  const journeyPlanNote = useMemo(() => {
    const moved = observedMilestoneIds().size;
    const total = AUTHORED_MILESTONES.length;
    return moved > 0
      ? `plan of ${ROADMAP_AUTHORED_AT} · ${moved} of ${total} moved by real work`
      : `plan of ${ROADMAP_AUTHORED_AT} · not yet moved by real work`;
  }, [viewMode]);
  return (
    <AnimatePresence>
      {viewMode === "journey" && (
        <motion.div
          key="journey-mode"
          className="pane"
          role="status"
          aria-label="journey mode — the roadmap tree"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
          // fixed + auto side-margins centre it without a transform, leaving `transform`
          // free for motion's y so centring and the slide-in never fight.
          style={{
            top: 54,
            left: 0,
            right: 0,
            marginInline: "auto",
            width: "max-content",
            maxWidth: "min(92vw, 520px)",
            zIndex: 11,
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "7px 8px 7px 14px",
            pointerEvents: "none",
          }}
        >
          <motion.span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              flex: "none",
              borderRadius: 999,
              background: "var(--base-cool)",
              boxShadow: "0 0 8px color-mix(in srgb, var(--base-cool) 75%, transparent)",
            }}
            animate={{ opacity: [1, 0.35, 1], scale: [1, 0.8, 1] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
          />
          <span
            style={{
              fontFamily: "var(--font-ui)",
              fontSize: "var(--fs-xs)",
              fontWeight: 700,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "var(--base-cool)",
              whiteSpace: "nowrap",
            }}
          >
            Journey
          </span>
          <span
            style={{
              fontFamily: "var(--font-serif)",
              fontStyle: "italic",
              fontSize: "var(--fs-sm)",
              color: "color-mix(in srgb, var(--text) 60%, transparent)",
              whiteSpace: "nowrap",
            }}
          >
            {journeyPlanNote}
          </span>
          <button
            onClick={() => usePraxisStore.getState().toggleViewMode()}
            title="back to the brain"
            style={{
              pointerEvents: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              marginLeft: 4,
              padding: "4px 9px",
              border: "1px solid color-mix(in srgb, var(--text) 12%, transparent)",
              borderRadius: 3,
              background: "transparent",
              cursor: "pointer",
              fontFamily: "var(--font-ui)",
              fontSize: "var(--fs-2xs)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--text-dim)",
              whiteSpace: "nowrap",
            }}
          >
            press <kbd>J</kbd> for brain
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* --------------------------------------------------------- window launcher --- */

/**
 * LauncherDock - the always-visible hyperlinks to Praxis's other windows, top-center.
 * The old Voice chip is retired (spec item 13): the keyboard drives the mic (hold T /
 * Ctrl+T), the state bar's waveform shows listening, and the backup Talk button lives
 * in the right dock's CONTROLS tab.
 *
 * Hold T only SIGNALS now. It used to run its own recorder into the old route.ts
 * ladder - a second, different assistant from the one CONVERSE talks to. VoicePopup
 * owns the one session; holding T opens a single turn in it and releasing sends it.
 */
function LauncherDock() {
  const tHeld = useRef(false);

  useEffect(() => {
    const typing = (el: EventTarget | null) => {
      const t = el as HTMLElement | null;
      return (
        !!t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
      );
    };
    const down = (e: KeyboardEvent) => {
      if ((e.key === "t" || e.key === "T") && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target)) {
        if (tHeld.current) return;
        tHeld.current = true;
        voiceHoldStart(); // hold-to-talk: open a single turn
      }
    };
    const up = (e: KeyboardEvent) => {
      if ((e.key === "t" || e.key === "T") && tHeld.current) {
        tHeld.current = false;
        voiceHoldEnd(); // release: send it
      }
    };
    // A window that loses focus mid-hold never sees the keyup; send rather than
    // leave the turn waiting on a key that is no longer down.
    const blur = () => {
      if (!tHeld.current) return;
      tHeld.current = false;
      voiceHoldEnd();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const wins: { label: string; glyph: Parameters<typeof Glyph>[0]["id"]; go: () => void; hint: string }[] = [
    { label: "Command Center", glyph: "pulse", go: openCommandCenter, hint: "the cockpit — autonomy, fleet, spend, launcher  ·  Ctrl+Alt+2" },
    { label: "Memory Galaxy", glyph: "orbit", go: openMemoryGalaxy, hint: "second-brain graph  ·  Ctrl+Alt+3" },
    { label: "Flight Deck", glyph: "deck", go: openFlightDeck, hint: "parallel Claude sessions  ·  Ctrl+Alt+4" },
  ];

  return (
    <>
      <nav className="launcher pane" aria-label="window launcher">
        {wins.map((w) => (
          <button key={w.label} className="launch-chip" onClick={w.go} title={w.hint}>
            <Glyph id={w.glyph} size={13} />
            <span>{w.label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}

/* ---------------------------------------------------- brand block (top-left) --- */

/** App version - real (Tauri getVersion), "DEV" in a plain browser. */
function useAppVersion(): string {
  const [v, setV] = useState("DEV");
  useEffect(() => {
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((ver) => setV(`V${ver} · ${__BUILD_TS__}`))
      .catch(() => {
        /* plain browser - stays DEV */
      });
  }, []);
  return v;
}

/** Live clock - HH:MM:SS + short date, ticking every second. */
function useClock(): { hms: string; date: string } {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const two = (n: number) => String(n).padStart(2, "0");
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const mons = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return {
    hms: `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`,
    date: `${days[now.getDay()]} ${two(now.getDate())} ${mons[now.getMonth()]}`,
  };
}

/**
 * BrandBlock - spec item 10: PRAXIS + trust badge · NEURAL FIELD + version +
 * live clock · executing/firing line. Every stat is live: trust mirrors the CC
 * dial, version comes from the installed binary, firing/tasks off the store,
 * HALTED overrides the mode line when the halt breaker is open.
 */
function BrandBlock() {
  const tasks = usePraxisStore((s) => s.tasks);
  const autonomy = usePraxisStore((s) => s.autonomy);
  const { halted } = useHalt();
  const version = useAppVersion();
  const { hms, date } = useClock();

  // ONE-TRUTH firing count - off the fd_sessions roster (useFiringAgents), the same
  // source Galaxy/CC/Flight Deck read, so the top-left "N firing" matches every window.
  const working = useFiringAgents().length;
  const activeTasks = Object.values(tasks).filter((t) => t.active).length;
  const executing = working > 0 || activeTasks > 0;
  // show the SAME detent name the Command Center + Controls tab show (audit: the
  // top-left said "OPERATOR" while everything else said "III · EXECUTE").
  const TRUST_DETENT: Record<string, string> = {
    observe: "I · OBSERVE",
    suggest: "II · PROPOSE",
    approve: "II · PROPOSE",
    operator: "III · EXECUTE",
    full: "IV · SOVEREIGN",
  };
  const leash = TRUST_DETENT[autonomy] ?? TRUST_LEVELS.find((l) => l.key === autonomy)?.label ?? autonomy;
  const mode = halted ? "halted" : executing ? "executing" : "observing";

  return (
    <header className="brand2" data-mode={mode}>
      <div className="brand2-row">
        <span className="brand2-mark" aria-hidden>◆</span>
        <h1 className="brand2-name">Praxis</h1>
        <span
          className="brand2-leash"
          data-level={autonomy}
          title={`Trust: ${leash} — set it in the Command Center`}
        >
          <span className="leash-dot" aria-hidden />
          {leash}
        </span>
      </div>
      <div className="brand2-meta mono">
        <span className="brand2-field">NEURAL FIELD</span>
        <span className="sep">·</span>
        <span>{version}</span>
        <span className="sep">·</span>
        <span>{hms}</span>
        <span className="sep">·</span>
        <span>{date}</span>
      </div>
      <p className="brand2-mode">
        <span className={`mode-dot ${halted ? "halt" : executing ? "on" : ""}`} aria-hidden />
        {halted ? (
          "halted"
        ) : executing ? (
          <>
            executing · <span className="mono">{working}</span> firing
            {activeTasks > 0 && (
              <>
                {" "}· <span className="mono">{activeTasks}</span> tasks
              </>
            )}
          </>
        ) : (
          "ready"
        )}
      </p>
    </header>
  );
}

/* ------------------------------------------------------------ left rail ---- */

function LeftRail() {
  const selectedId = usePraxisStore((s) => s.selectedId);
  const focusId = usePraxisStore((s) => s.focusId);
  const viewMode = usePraxisStore((s) => s.viewMode);
  const journeyAreaId = usePraxisStore((s) => s.journeyAreaId);
  const journeyCursorId = usePraxisStore((s) => s.journeyCursorId);
  const graphVersion = usePraxisStore((s) => s.graphVersion);
  const g = useMemo(() => buildGraph(), [graphVersion]);

  const areas = useMemo(() => g.nodes.filter((n) => n.tier === 1), [g]);

  // which sector the camera/selection is parked in (areas light their glyph)
  const current = focusId ?? selectedId;
  const node = current ? g.byId.get(current) : null;
  const focusArea = node ? (node.tier === 1 ? node.id : node.areaId) : null;
  // in journey mode the focused lane / task cursor drive the highlight
  const cursorArea = journeyCursorId ? g.byId.get(journeyCursorId)?.areaId : null;
  const activeArea =
    viewMode === "journey" ? journeyAreaId ?? cursorArea ?? focusArea : focusArea;

  // clicking an area switches lane in journey mode, flies to its sector in brain mode
  const clickArea = (id: string) =>
    viewMode === "journey"
      ? usePraxisStore.getState().focusAreaLane(id)
      : usePraxisStore.getState().focus(id);
  const focus = (id: string | null) => usePraxisStore.getState().focus(id);

  return (
    <nav className="rail pane" aria-label="map navigation">
      <button
        className={`rail-btn ${current == null ? "rail-on" : ""}`}
        onClick={() => focus(null)}
        title="Overview · Esc"
        aria-label="Overview"
      >
        <Glyph id="overview" size={18} />
      </button>

      <span className="rail-sep" aria-hidden />

      {areas.map((a, i) => (
        <button
          key={a.id}
          className={`rail-btn rail-area ${activeArea === a.id ? "rail-on" : ""}`}
          style={{ "--g": `var(--area-${a.id})` } as React.CSSProperties}
          onClick={() => clickArea(a.id)}
          title={`${a.label} · ${i + 1}`}
          aria-label={a.label}
        >
          <Glyph id={AREA_GLYPH[a.id] ?? "praxis"} size={18} />
        </button>
      ))}

      <span className="rail-sep" aria-hidden />

      <button
        className={`rail-btn ${viewMode === "journey" ? "rail-on" : ""}`}
        onClick={() => usePraxisStore.getState().toggleViewMode()}
        title="History layer · J"
        aria-label="History layer"
        aria-pressed={viewMode === "journey"}
      >
        <Glyph id="history" size={18} />
      </button>
    </nav>
  );
}

/* ------------------------------------------- dump dock (bottom-left corner) --- */

/** The Mission slot's leading mark: ring (running) · check (delivered) · triangle (stopped) · dot (unread) · + (idle). */
function DockMark({ tone }: { tone: ReturnType<typeof useMissionDock>["tone"] }) {
  if (tone === "live") return <i className="dd-mark dd-ring" aria-hidden />;
  if (tone === "done")
    return (
      <svg className="dd-mark" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (tone === "failed")
    return (
      <svg className="dd-mark" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path d="M8 2.8L14 13H2L8 2.8Z M8 7v2.6 M8 11.4h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (tone === "unread") return <i className="dd-mark dd-dot" aria-hidden />;
  return <Glyph id="add" size={13} />;
}

/**
 * DumpDock - spec item 12: dump-a-thought lives in the bottom-left corner and the
 * Atlas opens UP from the same spot (OrchestratorPanel anchors just
 * above this dock). Gesture + talk controls moved to the right dock's CONTROLS tab.
 *
 */
function DumpDock() {
  const chatOpen = usePraxisStore((s) => s.chatOpen);
  const dumpOpen = usePraxisStore((s) => s.dumpOpen);
  const dock = useMissionDock();
  const badge = dock.count > 9 ? "9+" : String(dock.count);
  return (
    <div className="dumpdock pane" role="group" aria-label="capture + planner">
      <button
        className={`dd-slot${dock.tone ? ` is-${dock.tone}` : ""}`}
        onClick={() => usePraxisStore.getState().setDumpOpen(!dumpOpen)}
        title={dock.title || "Mission — hand Praxis a job, or brain-dump an idea"}
        aria-label={
          dock.tone
            ? `${dock.title}${dock.count > 0 && dock.tone !== "unread" ? `, ${dock.count} unread` : ""}`
            : "Mission — hand Praxis a job, or brain-dump an idea"
        }
      >
        <DockMark tone={dock.tone} />
        <span className="dd-label">{dock.label || "dump a thought…"}</span>
        {dock.count > 0 && (
          <b className="dd-badge" aria-hidden>
            {badge}
          </b>
        )}
        <kbd>D</kbd>
      </button>
      {/* Praxis speaking while the panel is shut: announce it, don't make the owner go looking */}
      <span className="dd-sr" role="status" aria-live="polite">
        {dumpOpen ? "" : dock.announce}
      </span>
      <button
        className={`dd-btn ${chatOpen ? "on" : ""}`}
        onClick={() => usePraxisStore.getState().setChatOpen(!chatOpen)}
        title="Atlas · fast companion · O"
        aria-label="Atlas · fast companion"
        aria-pressed={chatOpen}
      >
        <Glyph id="chat" size={14} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------- nav hints ---- */

function NavHints() {
  const selectedId = usePraxisStore((s) => s.selectedId);
  const viewMode = usePraxisStore((s) => s.viewMode);
  const chatOpen = usePraxisStore((s) => s.chatOpen);
  const dumpOpen = usePraxisStore((s) => s.dumpOpen);
  const graphVersion = usePraxisStore((s) => s.graphVersion);
  const areaCount = useMemo(
    () => buildGraph().nodes.filter((n) => n.tier === 1).length,
    [graphVersion],
  );
  if (selectedId || chatOpen || dumpOpen) return null;
  // journey mode: the transport (JourneyNav) shows the verbs - just the exit hint
  return viewMode === "journey" ? (
    <div className="hud-hints">
      <span className="hint-strong">journey</span>
      <span className="sep">·</span>
      <span>
        move through time, areas &amp; tasks below · <kbd>J</kbd> exit
      </span>
    </div>
  ) : (
    <div className="hud-hints">
      <span>drag to pan</span>
      <span className="sep">·</span>
      <span>scroll to zoom</span>
      <span className="sep">·</span>
      <span>click to fly in</span>
      <span className="sep">·</span>
      <span>
        <kbd>1</kbd>–<kbd>{areaCount}</kbd> areas
      </span>
      <span className="sep">·</span>
      <span>
        <kbd>J</kbd> journey
      </span>
    </div>
  );
}
