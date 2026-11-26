/**
 * Command Center v2 - the cockpit of Praxis, rebuilt 1:1 to the approved Claude
 * Design package (Praxis Command Center.dc.html, 2026-07-05): a single control
 * surface where nearly every element is an actionable control over real backend
 * state. Status rail (engine/infra/fleet/rails/breakers/voice/HALT ALL) over a
 * three-column instrument grid: MODE + TRUST + INBOX · FLEET + MANIFEST (resizable
 * split) · SUPPLY + BREAKERS, plus the full-screen document overlay for reports.
 *
 * All state is the REAL stores: controlStore (mode/breakers/usage), fleetStore
 * (REV 2 model table), brainStore, todoStore, inboxStore, haltStore, shared
 * autonomy. The design's demo scaffolding (tickers, fake activity pools,
 * click-to-cycle engine chip) is deliberately not ported.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useWindowHeartbeat } from '@/shared/useWindowHeartbeat';
import { useAgentRoster } from "@/shared/agents";
import { visibleInterval } from "@/shared/visibility";
import { useWindowShortcuts } from "@/shared/useWindowShortcuts";
import { inPraxisTauri, usePraxisStatus, type PraxisStatusState } from "@/shared/praxisStatus";
import { generateBoardMeeting } from "@/orchestrator/boardMeeting";
import { C } from "./ccTheme";
import { StatusRail, type QuartzView, type VoiceView } from "./StatusRail";
import { ModePanel } from "./ModePanel";
import { TrustPanel, detentFromAutonomy } from "./TrustPanel";
import { InboxPanel } from "./InboxPanel";
import { FleetPanel, deriveFleet } from "./FleetPanel";
import { ManifestPanel } from "./ManifestPanel";
import { SupplyPanel, buildRails } from "./SupplyPanel";
import { BreakersPanel } from "./BreakersPanel";
import { DocOverlay } from "./DocOverlay";
import { useToolToggles, useExecMode, useUsage, TOOL_ROWS } from "./controlStore";
import { useFleetModels } from "./fleetStore";
import { useBrain, useBrainRail } from "./brainStore";
import { useTodoStore } from "./todoStore";
import { useInbox, type InboxItem, type InboxDoc } from "./inboxStore";
import { useHalt, syncHaltToNative } from "./haltStore";
import { useWatchMe } from "@/components/watchMeStore";
import { useVoiceUsage } from "./voiceUsageStore";
import { useCursorPoolState } from "./cursorPoolStore";
import { VoiceStateSatellite } from "@/voice/VoiceStateIndicator";
import "./command.css";

import { useRestoreListener } from "@/shared/restore";
import { useLiveOnResume } from "@/shared/liveOnResume";
import { useHermesHealthState } from "@/shared/hermesHealth";
export default function App() {
  // Restore (Controls tab) reloads every window; this window must hear it.
  useRestoreListener();
  // Re-measure after a gap: a cached reading is a fact with a shelf life.
  useLiveOnResume();
  useWindowHeartbeat();
  const { agents } = useAgentRoster();
  const hermes = useHermesHealth();
  const quartz = useQuartzStatus();
  const { halted, toggleHalt } = useHalt();
  const { mode, setMode } = useExecMode();
  const toolStore = useToolToggles();
  const fleet = useFleetModels();
  const brainStore = useBrain();
  const brainRail = useBrainRail();
  const todo = useTodoStore();
  const { sources, lastLiveMs, refresh } = useUsage();
  const voiceUsage = useVoiceUsage();
  const cursorPool = useCursorPoolState();
  // Watch-me is a real breaker too (rendered in BreakersPanel), so the top rail must
  // count it - enabled=false means the breaker is open.
  const watchMeOff = useWatchMe((s) => s.enabled) === false;
  const inbox = useInbox(hermes);
  // Seed from the REAL persisted autonomy (same logic TrustPanel itself uses) so the
  // sovereign badge never flashes a wrong detent on first paint - a hardcoded 3 here
  // used to render one frame before TrustPanel's own mount effect corrected it.
  const [trust, setTrust] = useState<number>(detentFromAutonomy);
  const voice = useVoiceView(mode === "hybrid", halted);
  const version = useAppVersion();
  useWindowShortcuts(); // Ctrl+Alt+1-4 jump windows · Ctrl+Alt+←/→ cycle

  // ── Fleet derivation (rows + rail counts from one pass) ──
  const derived = deriveFleet({
    roster: agents,
    mode,
    halted,
    toggles: toolStore.toggles,
    selections: fleet.selections,
    brain: brainStore.brain,
    engineDegraded: !!hermes?.degraded,
    voiceLabel: voice?.label ?? null,
    sources,
    brainRail,
  });

  const { tightest, alerts: railAlerts } = buildRails(sources, lastLiveMs, cursorPool);
  // Tool breakers + watch-me, so "BREAKERS CLOSED" never lies while any is open
  // (2026-07-10 Codex live QA, CC breaker rail).
  const openToolBreakers = TOOL_ROWS.filter((r) => toolStore.toggles[r.key] === false).length;
  const openBreakers = openToolBreakers + (watchMeOff ? 1 : 0);
  const openai = sources.find((s) => s.key === "openai");
  const voiceCreditLeft = openai && openai.limit != null ? Math.max(0, openai.limit - openai.spend) : null;

  // ── Document overlay ──
  const [docOpen, setDocOpen] = useState<InboxDoc | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDocOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Re-assert the HALT breaker into the Rust-side mirror (halted.txt) once at
  // startup, so the native FlowRunner's HALT gate reflects a breaker thrown in a
  // prior session (localStorage persists; the mirror must be re-written on launch).
  useEffect(() => {
    syncHaltToNative();
  }, []);

  const openItem = (n: InboxItem) => {
    inbox.markRead(n.id);
    if (n.doc) setDocOpen(n.doc);
  };

  // Manual board regenerate from the overlay - mirrors boardMeetingStore's cache
  // shape so the main window's scheduler (the ONLY scheduler - not duplicated
  // here) sees today as covered. Local flag only; no second 6am timer.
  const regenerateBoard = useCallback(async () => {
    setRegenerating(true);
    try {
      const result = await generateBoardMeeting(agents);
      if (result) {
        try {
          localStorage.setItem(
            "praxis.board.v1",
            JSON.stringify({
              date: result.date,
              digestMarkdown: result.digestMarkdown,
              path: result.path,
              hadData: result.hadData,
              generatedAtMs: Date.now(),
            }),
          );
        } catch {
          /* best-effort cache */
        }
        inbox.refresh();
        setDocOpen(null);
      }
    } finally {
      setRegenerating(false);
    }
  }, [agents, inbox]);

  // ── Fleet/Manifest divider (pointer-drag, 18–76% of the center column) ──
  const centerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ active: boolean; rect: DOMRect | null }>({ active: false, rect: null });
  const [fleetBasis, setFleetBasis] = useState(52);

  const dividerDown = (e: React.PointerEvent) => {
    const col = centerRef.current;
    if (!col) return;
    e.preventDefault();
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      /* pointer capture unsupported - drag still works while over the divider */
    }
    dragRef.current = { active: true, rect: col.getBoundingClientRect() };
  };
  const dividerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.active || !d.rect) return;
    const pct = ((e.clientY - d.rect.top) / d.rect.height) * 100;
    setFleetBasis(Math.min(76, Math.max(18, +pct.toFixed(2))));
  };
  const dividerUp = () => {
    dragRef.current.active = false;
  };

  // THREE states, because a missing health fact is not a healthy one.
  // `hermes` is null until the observer emits, and the observer only runs after
  // ensure_dashboard() + wait_ready(), which can take up to READY_TIMEOUT_SECS -
  // so mapping null to "linked" made a freshly-opened Command Center assert
  // "engine · nominal" before anything had been probed at all.
  const engine: "linked" | "degraded" | "checking" = !hermes
    ? "checking"
    : hermes.degraded
      ? "degraded"
      : "linked";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: C.abyss,
        color: C.ink,
        fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
        fontSize: 12,
        minWidth: 1240,
        overflow: "auto",
        // 1.03 keeps a touch of the enlargement without starving it.
        zoom: 1.03,
      }}
    >
      <StatusRail
        engine={engine}
        engineReason={hermes?.reason ?? ""}
        quartz={quartz}
        running={derived.running}
        cutCount={derived.cutCount}
        tightest={tightest}
        railAlert={railAlerts[0] ?? null}
        openBreakers={openBreakers}
        watchMeOff={watchMeOff}
        voice={voice}
        halted={halted}
        toggleHalt={toggleHalt}
        sovereign={trust === 4}
        version={version}
      />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "308px minmax(0,1fr) 340px",
          gap: 2,
          background: C.seam,
          borderTop: "1px solid rgba(233,220,196,.05)",
        }}
      >
        {/* ── LEFT · AUTHORITY + INBOX ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minHeight: 0, overflowY: "auto" }}>
          <ModePanel mode={mode} setMode={setMode} toggles={toolStore.toggles} halted={halted} />
          <TrustPanel onTrustChange={setTrust} />
          <InboxPanel items={inbox.items} unreadCount={inbox.unreadCount} onOpen={openItem} />
        </div>

        {/* ── CENTER · FLEET + MANIFEST ── */}
        <div ref={centerRef} style={{ display: "flex", flexDirection: "column", gap: 2, minHeight: 0 }}>
          <FleetPanel
            derived={derived}
            fleet={fleet}
            brainStore={brainStore}
            toggles={toolStore.toggles}
            fleetBasis={fleetBasis}
            voiceCreditLeft={voiceCreditLeft}
          />
          <div
            className="px-hover-divider"
            title="drag to resize fleet / manifest"
            onPointerDown={dividerDown}
            onPointerMove={dividerMove}
            onPointerUp={dividerUp}
            onPointerCancel={dividerUp}
            style={{
              flex: "none",
              height: 9,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "row-resize",
              background: C.panel,
              touchAction: "none",
            }}
          >
            <span style={{ width: 34, height: 3, borderRadius: 2, background: "rgba(233,226,211,.22)" }} />
          </div>
          <ManifestPanel todo={todo} hermesToggleOn={toolStore.toggles["hermes"] !== false} engineDegraded={!!hermes?.degraded} />
        </div>

        {/* ── RIGHT · SUPPLY + BREAKERS ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minHeight: 0, overflowY: "auto" }}>
          <SupplyPanel sources={sources} voiceUsage={voiceUsage} cursorPool={cursorPool} lastLiveMs={lastLiveMs} onReload={refresh} />
          <BreakersPanel toggles={toolStore.toggles} setTool={toolStore.setTool} />
        </div>
      </div>

      {docOpen && (
        <DocOverlay
          doc={docOpen}
          onClose={() => setDocOpen(null)}
          onRegenerate={docOpen.kind === "board" ? () => void regenerateBoard() : undefined}
          regenerating={regenerating}
        />
      )}

      {/* The voice-state pill follows whichever Praxis window the owner is working in.
          A SATELLITE: state only, no microphone. Only the window that owns the
          conversation runs the engine, because three more mounted engines would be
          three more mics rather than one assistant visible in four places. */}
      <VoiceStateSatellite />
    </div>
  );
}

/* ------------------------------------------------------------- hermes health --- */

/** Driven by `praxis://hermes-degraded` (hermes_bridge.rs observer loop, real HTTP
 *  probe on every healthy⇄degraded transition). */
function useHermesHealth(): { degraded: boolean; reason: string } | null {
  // Pull + listen (src/shared/hermesHealth.ts). Listening alone missed the one
  // change-only emit, and this window always opens after it - "checking…" forever.
  return useHermesHealthState();
}

/* ------------------------------------------------------------------ version --- */

/** Real installed-app version (tauri.conf.json's version - the one truth), the same
 *  `getVersion()` read the Flight Deck header and Memory Galaxy brand line already use
 *  (see DeckApp.tsx / knowledge/App.tsx) - CC's header showed no version at all while
 *  the other three windows did (2026-07-10 CDP QA, CC-7). Empty until resolved (a
 *  hardcoded string would go stale the first release after it was written); the header
 *  simply omits the chip until then. */
function useAppVersion(): string {
  const [version, setVersion] = useState("");
  useEffect(() => {
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then((v) => setVersion(`${v} · ${__BUILD_TS__}`))
      .catch(() => {
        /* not inside the Tauri shell - header just omits the version */
      });
  }, []);
  return version;
}

/* ------------------------------------------------------------- quartz health --- */

/** QUARTZ chip: honest lifecycle state of the lazy vault sidecar, polled at the
 *  same 30s cadence as the usage meters. null = not yet known. */
function useQuartzStatus(): QuartzView | null {
  const [status, setStatus] = useState<QuartzView | null>(null);
  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const value = await invoke<QuartzView>("quartz_status");
        if (!cancelled) setStatus(value);
      } catch {
        if (!cancelled) setStatus(null); // command missing / dev browser - chip shows "…"
      }
    };
    void pull();
    // Pause the quartz_status probe while the CC window is hidden; catch up on return.
    const stop = visibleInterval(() => void pull(), 30_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);
  return status;
}

/* ---------------------------------------------------------------- voice view --- */

/** The rail's voice cluster follows the brain window's `praxis://status` event.
 *  In a plain browser there is no Tauri event bus, so it keeps the old filmable
 *  LISTENING fallback. */
function useVoiceView(hybrid: boolean, halted: boolean): VoiceView | null {
  const live = usePraxisStatus();
  if (!hybrid) return null;
  if (halted) return { label: "SUSPENDED", color: C.faint, barAnim: "none", line: "—" };
  const browserFallback = !inPraxisTauri();
  const s: PraxisStatusState = live?.state ?? (browserFallback ? "listening" : "idle");
  const line = live?.detail ?? (browserFallback ? "ambient — just talk" : "waiting for brain status");
  if (s === "speaking") return { label: "SPEAKING", color: C.sapphireLt, barAnim: "pxWave .7s ease-in-out infinite", line };
  if (s === "acting") return { label: "ACTING", color: C.amethystLt, barAnim: "pxBlink 1s ease-in-out infinite", line };
  if (s === "executing") return { label: "EXECUTING", color: C.emerald, barAnim: "pxPulse 1.6s ease-in-out infinite", line };
  if (s === "listening") return { label: "LISTENING", color: C.emerald, barAnim: "pxWave 1.3s ease-in-out infinite", line };
  return { label: "IDLE", color: C.faint, barAnim: "none", line };
}
