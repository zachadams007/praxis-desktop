import { useCallback, useEffect, useState } from "react";
import { Leva } from "leva";
import { MotionConfig } from "motion/react";
import { ThemeApplier } from "@/theme/ThemeProvider";
import { useWindowHeartbeat } from '@/shared/useWindowHeartbeat';
import { DevControls } from "@/components/DevControls";
import { BrainCanvas } from "@/components/BrainCanvas";
import { BrainHudScaler } from "@/shared/FitScaler";
import "@/shared/fitScaler.css";
import { Hud } from "@/components/Hud";
import { Pullout, RightDock } from "@/components/RightDock";
import { GesturePanel } from "@/components/GesturePanel";
import { DumpBox } from "@/components/DumpBox";
import { OrchestratorPanel } from "@/components/OrchestratorPanel";
import { useFileWatch } from "@/data/fileWatch";
import { useRealEvents } from "@/data/useRealEvents";
import { useSageWatch } from "@/research/sageWatch";
import { useBoardMeeting } from "@/command/boardMeetingStore";
import { usePraxisWake } from "@/hooks/usePraxisWake";
import { useGlobalKeys } from "@/lib/useGlobalKeys";
import { useWindowShortcuts } from "@/shared/useWindowShortcuts";
import { usePraxisStore } from "@/store/usePraxisStore";
import { voiceOnceText } from "@/voice/voiceEvents";
import { VoicePopup } from "@/voice/VoicePopup";
import { OperatorOverlay } from "@/operator/OperatorOverlay";
import { VetoOverlay } from "@/components/VetoOverlay";
import { CredentialOverlay } from "@/components/CredentialOverlay";
import { WatchMe } from "@/components/WatchMe";
import { PanelBoundary } from "@/components/PanelBoundary";
import type { AutonomyKey } from "@/shared/autonomy";

import { useRestoreListener } from "@/shared/restore";
import { useLiveOnResume } from "@/shared/liveOnResume";
if (import.meta.env.DEV) {
  (window as unknown as { __praxisStore?: typeof usePraxisStore }).__praxisStore = usePraxisStore;
}

/** Report a successful mount to the boot watchdog (src-tauri lib.rs `boot_ok`).
 *  An effect only runs if React actually COMMITTED the tree - a render crash never
 *  reaches it - so this is the honest "window is not blank" signal. The watchdog
 *  restarts the app once if this never arrives (grey-window class, 2026-07-09). */
function useBootOk() {
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke("boot_ok")).catch(() => {});
  }, []);
}

/**
 * NEURAL FIELD - the evolved volumetric connectome brain (R3F scene + glass HUD).
 *
 * BrainCanvas is the WebGL layer: rendered UNSCALED, full-window, via
 * BrainHudScaler's `canvas` slot, so it always measures a real pixel-for-pixel
 * container (no CSS transform blur). Everything else here is HUD chrome - DOM/CSS
 * only - and rides inside the scaled+letterboxed wrapper, same as the other three
 * windows, so it never crops when this window isn't maximized.
 */
function NeuralView() {
  return (
    <BrainHudScaler canvas={<BrainCanvas />}>
      <PanelBoundary name="The HUD"><Hud /></PanelBoundary>
      <PanelBoundary name="The dock"><RightDock /></PanelBoundary>
      {/* Phase-C demonstration surface - the inspector doc pulled out across the
          screen (voice: "give me the board summary"). Renders above the dock. */}
      <PanelBoundary name="The pull-out"><Pullout /></PanelBoundary>
      <PanelBoundary name="The orchestrator panel"><OrchestratorPanel /></PanelBoundary>
      <PanelBoundary name="Mission"><DumpBox /></PanelBoundary>
      <PanelBoundary name="Gestures"><GesturePanel /></PanelBoundary>
      {/* Voice lives in the top LauncherDock (hold-T / chip click).
          VoicePopup adds the bottom-right Praxis result panel: hold-T or click the orb
          to talk, then routes through the shared voice backend. */}
      <PanelBoundary name="Voice"><VoicePopup /></PanelBoundary>
      {/* Top-center mission banner narrating visible computer-use runs
          (operator:phase events from computer_use.rs). */}
      <PanelBoundary name="The operator banner"><OperatorOverlay /></PanelBoundary>
      {/* Sovereign (Trust IV) human veto gate: blocks on praxis://veto-request
          before any irreversible action (pay/post/send/login/create-account) that
          sovereign.rs is about to take, and emits praxis://veto-response. */}
      <PanelBoundary name="The veto gate"><VetoOverlay /></PanelBoundary>
      {/* Sovereign give-a-password-ONCE gate: when the browser sidecar needs a
          credential the DPAPI vault doesn't have, sovereign.rs emits
          praxis://credential-request and blocks; this asks the owner once, Rust persists
          it to the vault, and every later action reuses it. */}
      <PanelBoundary name="The password gate"><CredentialOverlay /></PanelBoundary>
      {/* Watch-me / screen-share: Praxis WATCHES the owner's screen and answers questions about
          what he's doing (the observe inverse of the sovereign control path). Toggle chip
          bottom-left; on-demand ask sends the latest frame to a vision model. */}
      <PanelBoundary name="Watch-me"><WatchMe /></PanelBoundary>
    </BrainHudScaler>
  );
}

/** Let another window switch this one's view. The Memory Galaxy / Command Center
 *  nav buttons raise the brain window through `show_main_view_cmd`, which emits
 *  `praxis://view` - without this the "Journey" button raised the brain window on
 *  whatever view happened to be active, so a button labelled Journey did not go
 *  to Journey. */
function useViewRequests() {
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window || '__TAURI__' in window)) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<string>("praxis://view", (e) => {
          const v = e.payload;
          if (v === "journey" || v === "brain") usePraxisStore.getState().setViewMode(v);
        }),
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
}

export default function App() {
  // Restore (Controls tab) reloads every window; this window must hear it.
  useRestoreListener();
  // Re-measure after a gap: a cached reading is a fact with a shelf life.
  useLiveOnResume();
  useBootOk();
  useViewRequests();
  useWindowHeartbeat();
  const [isWaking, setIsWaking] = useState(false);

  const handleWake = useCallback(() => {
    setIsWaking(true);
    setTimeout(() => setIsWaking(false), 2000);
  }, []);

  useFileWatch(); // real file-births in the Tauri shell; inert in the browser
  useRealEvents(); // real Claude-session activity → the brain (Tauri only; inert in browser)
  useSageWatch(); // Sage's research-watch loop: drains new-video transcript digests (Tauri only)
  // Board-meeting's 6am scheduler + catch-up, mounted here (not just the Command Center
  // window) so it actually fires while the app just sits in the tray - the main window
  // is the one Tauri keeps genuinely alive on close (lib.rs hides rather than destroys
  // it), unlike the Command Center window, which may never be opened on a given day.
  // Safe to also be mounted in the CC window when it's open: both instances share the
  // same localStorage cache + the vault file's exists-today check, so a rare double-fire
  // race just means one generation wins, never a crash or duplicate schedule drift.
  useBoardMeeting();
  useGlobalKeys(); // J = journey · ←/→ = time · ↑/↓ = area · [ ] = task · D/O = panels
  useWindowShortcuts(); // Ctrl+Alt+1-4 jump windows · Ctrl+Alt+←/→ cycle
  usePraxisWake(handleWake);

  // Missions that were waiting for an agent's usage window (missionDeferral.ts) start again
  // on their own after a restart. Main window only, so no second window double-runs them.
  useEffect(() => {
    void import("@/orchestrator/missionDeferral")
      .then(({ rearmDeferredMissions }) => rearmDeferredMissions())
      .catch(() => {
        /* storage unavailable - nothing queued to resume */
      });
  }, []);

  // Read-only agent snapshot for the live QA harness (tools/praxis-verify/mission-e2e.cjs):
  // the whole store is exposed only in DEV, so the installed app had no way to prove which
  // agent was working on which mission node. Returns copies; nothing can be mutated through it.
  useEffect(() => {
    (window as unknown as { __praxisAgentState?: () => Record<string, unknown> }).__praxisAgentState = () =>
      Object.fromEntries(
        Object.entries(usePraxisStore.getState().agents).map(([id, a]) => [
          id,
          { status: a.status, taskId: a.taskId ?? null, areaId: a.areaId ?? null, title: a.title ?? null, model: a.model ?? null },
        ]),
      );
  }, []);

  // Learning AI surface: fold any skills Praxis has learned into the brain graph
  // (under Learning AI → Skills) once on startup. Guarded + inert in the browser.
  useEffect(() => {
    void import("@/orchestrator/skills")
      .then(({ refreshSkillArtifacts }) => refreshSkillArtifacts())
      .catch(() => {
        /* skill store unavailable (dev browser) - cluster keeps its authored artifacts */
      });
  }, []);

  // surface a Flight Deck launch failure instead of letting it be a silent no-op
  // (pairs with the Rust-side emit on window-build error)
  useEffect(() => {
    let off: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<string>("praxis://flightdeck-error", (e) =>
          usePraxisStore.getState().notify(`Flight Deck error: ${e.payload}`),
        ),
      )
      .then((f) => {
        off = f;
      })
      .catch(() => {
        /* not inside the Tauri shell - nothing to listen for */
      });
    return () => off?.();
  }, []);

  // Hermes degraded-state signal: the :9119 sidecar can be TCP-listening but its asyncio
  // loop stalled (both HTTP and WS hang, feed goes silently quiet). hermes_bridge.rs's
  // observer loop now health-probes it for real and emits praxis://hermes-degraded on every
  // healthy⇄degraded transition - surface that here so "the feed just isn't moving" reads as
  // an explicit banner ("Hermes degraded - …") instead of nothing.
  useEffect(() => {
    let off: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ degraded: boolean; reason: string }>("praxis://hermes-degraded", (e) => {
          if (e.payload.degraded) {
            usePraxisStore.getState().notify(`Hermes degraded — ${e.payload.reason}`);
          } else {
            usePraxisStore.getState().notify("Hermes recovered");
          }
        }),
      )
      .then((f) => {
        off = f;
      })
      .catch(() => {
        /* not inside the Tauri shell - nothing to listen for */
      });
    return () => off?.();
  }, []);

  // Sovereign (Trust IV) runtime signals.
  useEffect(() => {
    const offs: Array<() => void> = [];
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        Promise.all([
          listen<{ reason?: string }>("praxis://sovereign-takeover", (e) => {
            usePraxisStore
              .getState()
              .notify(`Sovereign needs you — ${e.payload?.reason ?? "a CAPTCHA or verification wall is blocking the browser. Solve it in the Praxis browser window, then re-run the goal."}`);
          }),
          listen<{ action?: string; summary?: string }>("praxis://sovereign-step", (e) => {
            if (e.payload?.action === "vault-warn" && e.payload.summary) {
              usePraxisStore.getState().notify(`Sovereign: ${e.payload.summary}`);
            }
          }),
        ]),
      )
      .then((fns) => offs.push(...fns))
      .catch(() => {
        /* not inside the Tauri shell - nothing to listen for */
      });
    return () => offs.forEach((f) => f());
  }, []);

  // Cross-window command bus: the secondary windows (Command Center cockpit, Memory
  // Galaxy) speak to the brain - the one window that owns the store + the voice. Two
  // payload shapes ride praxis://command:
  //   • { id } - a launcher button (click): run the named verb here.
  //   • { utterance } - a raw phrase a secondary window's mic heard: parse it with the
  //                     brain's own area graph, run it, and SPEAK the reply (one mouth).
  // A separate praxis://autonomy carries the trust-dial level. So "Praxis, open the
  // journey" from the cockpit actually moves THIS window - one vocabulary, one source.
  useEffect(() => {
    const offs: Array<() => void> = [];
    const run = (payload?: { id?: string; utterance?: string }) => {
      if (!payload) return;
      if (payload.utterance) {
        // Same session as Ctrl+T, with the words already in hand.
        voiceOnceText(payload.utterance);
        return;
      }
      const s = usePraxisStore.getState();
      switch (payload.id) {
        case "journey": s.setViewMode("journey"); break;
        case "brain": s.setViewMode("brain"); break;
        case "overview":
        case "areas": s.focus(null); break;
        case "dump": s.setDumpOpen(true); break;
        case "planner": s.setChatOpen(true); break;
        case "voice": s.setVoiceOn(true); break;
        case "gesture": s.setMode("gesture"); break;
      }
    };
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        Promise.all([
          listen<{ id?: string; utterance?: string }>("praxis://command", (e) => run(e.payload)),
          listen<{ level?: AutonomyKey }>("praxis://autonomy", (e) => {
            if (e.payload?.level) usePraxisStore.getState().setAutonomy(e.payload.level);
          }),
        ]),
      )
      .then((fns) => offs.push(...fns))
      .catch(() => {
        /* not inside the Tauri shell */
      });
    return () => offs.forEach((f) => f());
  }, []);

  return (
    // reducedMotion="user": every HUD spring/panel respects the OS setting,
    // matching the morph + camera (hard constraint: reduced-motion honored)
    <MotionConfig reducedMotion="user">
      <div className={isWaking ? "app-root praxis-root praxis-waking" : "app-root praxis-root"}>
        <ThemeApplier />
        {/* dev-only chrome - leva Theme-Lab + nav/perf toggles, docked BELOW the
            chip row. Gated so the SHIPPED app is a clean canvas, not a
            "praxis · dev" inspector sitting on the brain. */}
        {import.meta.env.DEV && (
          <>
            <div className="leva-dock">
              <Leva fill collapsed titleBar={{ title: "praxis · dev" }} />
            </div>
            <DevControls />
          </>
        )}
        {/* Neural Field is THE direction - Atlas was removed (the owner's pick). */}
        <NeuralView />
      </div>
    </MotionConfig>
  );
}
