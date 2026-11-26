/**
 * useGalaxyRealEvents - feed REAL Claude-session activity into the MEMORY GALAXY window's
 * event bus, so the galaxy's live bridge (eventAdapter → engine.applyEvent) rides reality
 * instead of nothing.
 *
 * WHY THIS EXISTS (2026-07-09 visual-truth wiring): the galaxy is its own Vite bundle running
 * in a SEPARATE webview process from the brain. useRealEvents (src/data/useRealEvents.ts) is
 * only mounted in the brain window (src/App.tsx), so its emits land on the BRAIN bundle's
 * eventBus singleton. The galaxy bundle has its OWN eventBus instance (the one eventAdapter.ts
 * subscribes to), and nothing ever emitted into it - so every real agent:thinking / task /
 * memory event was dropped on the floor here and engine.applyEvent() never saw a real event in
 * the shipped app. This hook is the galaxy's own copy of the PUSH translation: it listens to
 * the same Tauri push channels the brain's bridge uses and emits the SAME flat PraxisEvent
 * shapes onto the galaxy's eventBus, so attachEventBridge (Galaxy.tsx) turns them into real
 * vault mutations (traffic beads, weaves, births, rig retargeting).
 *
 * PUSH-only by design: the galaxy has no mock timeline to pause (the brain owns that), so this
 * deliberately omits useRealEvents' fd_sessions poll + mock-takeover. The Rust push bus
 * (transcript_tailer.rs / session_poller.rs / hermes_brain) is the authority. Inert outside
 * Tauri (never throws in a plain browser). The PURE mappers (repoToArea / agentIdForDriver /
 * areaTask) are imported READ-ONLY from src/data/realEvents.ts so there is one translation
 * truth shared with the brain's bridge.
 */

import { useEffect } from "react";
import { eventBus } from "@/data/eventBus";
import {
  areaTask,
  hermesEvents,
  agentIdForDriver,
  repoToArea,
  areaForWorkspace,
  sessionStateEvents,
  transcriptEvents,
} from "@/data/realEvents";
import type {
  HermesEventPayload,
  SessionStatePayload,
  TranscriptEventPayload,
} from "@/data/realEvents";

const HANDOFF_WINDOW_S = 5; // A ends, B starts in the same area within this → handoff

// The three PUSH-channel payloads and their translation now live in @/data/realEvents,
// shared verbatim with the brain window (useRealEvents.ts), so the two windows' bridges
// can never drift. This hook keeps only the galaxy's window-specific wiring below.

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

export function useGalaxyRealEvents(): void {
  useEffect(() => {
    if (!inTauri()) return; // browser / headless: no real push bus; ambient stays as ambience
    let cancelled = false;

    const nowT = () => performance.now() / 1000;

    // Stable area / agent / task per session (areaTask hits the cached graph).
    const meta = new Map<string, { area: string; agentId: string; taskId?: string }>();
    const metaFor = (sessionId: string, cwd: string) => {
      let m = meta.get(sessionId);
      if (!m) {
        const area = repoToArea(cwd);
        // The push bus carries Claude Code's own session files, so the worker is Forge -
        // attributed by driver like the brain window, never a hash pick among the area's
        // agents (that pick lit Lens/Vega for the owner's own Claude session, 2026-09-24).
        m = { area, agentId: agentIdForDriver("claude") ?? "a.forge", taskId: areaTask(area, sessionId) };
        meta.set(sessionId, m);
      }
      return m;
    };

    // recently-stopped sessions, for area-handoff inference (A ends → B starts).
    const recentStops: Array<{ area: string; agentId: string; at: number }> = [];

    // ── push handlers (translation is the SHARED realEvents copy) ──────────────────────
    const onTranscript = (p: TranscriptEventPayload) => {
      if (!areaForWorkspace(p.cwd)) return; // only real project work moves an agent (see realEvents.ts)
      const m = metaFor(p.session_id, p.cwd);
      for (const e of transcriptEvents(p, m, nowT())) eventBus.emit(e);
    };

    const onSessionState = (p: SessionStatePayload) => {
      if (!areaForWorkspace(p.cwd)) return;
      const m = metaFor(p.session_id, p.cwd);
      // Galaxy has NO journey plan, so emitJourneyStatus: false - the ONE divergence
      // from the brain window's session-state translation.
      for (const e of sessionStateEvents(p, m, nowT(), {
        recentStops,
        handoffWindowS: HANDOFF_WINDOW_S,
        emitJourneyStatus: false,
      })) {
        eventBus.emit(e);
      }
      // free the per-session meta once it docks (session ended)
      if (!p.running_after && p.running_before) meta.delete(p.session_id);
    };

    const onHermesEvent = (p: HermesEventPayload) => {
      for (const e of hermesEvents(p, nowT())) eventBus.emit(e);
    };

    // ── listeners (push bus) ────────────────────────────────────────────────────
    const unlisteners: Array<() => void> = [];
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const offT = await listen<TranscriptEventPayload>("praxis://transcript-event", (e) =>
          onTranscript(e.payload),
        );
        const offS = await listen<SessionStatePayload>("praxis://session-state", (e) =>
          onSessionState(e.payload),
        );
        const offH = await listen<HermesEventPayload>("praxis://hermes-event", (e) =>
          onHermesEvent(e.payload),
        );
        if (cancelled) {
          offT();
          offS();
          offH();
        } else {
          unlisteners.push(offT, offS, offH);
        }
      } catch {
        /* not inside the Tauri shell - push bus simply absent */
      }
    })();

    return () => {
      cancelled = true;
      for (const off of unlisteners) off();
    };
  }, []);
}
