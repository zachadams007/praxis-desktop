/**
 * useRealEvents - feed REAL Claude-session activity into the brain's eventBus.
 * The mirror of useFileWatch: inert outside the Tauri shell, never throws in a
 * plain browser. Two complementary sources, both mapping to the SAME flat
 * PraxisEvent shapes the mock timeline emits (so every downstream visual - lobe
 * glow, agent travel, comet trails, agent + journey handoffs, the voice ripple -
 * works unchanged):
 *
 *   • PUSH (Phase 2b, the rich signal): the Rust real-event bus tails real
 *     transcripts and diffs the running set, emitting `praxis://transcript-event`
 *     (assistant prose → core speaks + the agent thinks; tool_use → activity) and
 *     `praxis://session-state` (running transitions → agent flies in / docks). This
 *     is push-based and ~half-second snappy. See src-tauri/src/transcript_tailer.rs
 *     + session_poller.rs.
 *   • POLL (Phase 2a, the fallback): a 2.5s poll of `fd_sessions` that pauses the
 *     mock while real sessions run and - only when the push bus is ABSENT (an older
 *     build with no new Rust) - synthesizes the coarse events itself.
 *
 * Once any push event arrives, `pushAlive` flips and the poll stops synthesizing
 * events (the push bus is the authority); the poll then only owns the mock-takeover
 * toggle. This is the dedupe: push wins, poll never double-fires alongside it.
 */

import { useEffect } from "react";
import { isVisible, onVisibilityChange } from "@/shared/visibility";
import { eventBus } from "./eventBus";
import { usePraxisStore } from "@/store/usePraxisStore";
import { fetchLanes } from "@/flightdeck/api";
import {
  anyRunning,
  areaTask,
  diffSnapshots,
  flattenSnapshot,
  hermesEvents,
  repoToArea,
  areaForWorkspace,
  resolveTaskAndTitle,
  sessionStateEvents,
  sessionToAgentId,
  agentIdForDriver,
  transcriptEvents,
} from "./realEvents";
import type {
  HermesEventPayload,
  SessionStatePayload,
  TranscriptEventPayload,
} from "./realEvents";
import { journeySuccessor } from "./journey";
import type { LanesSnapshot } from "@/flightdeck/types";

// 5s: this poll is the FALLBACK - praxis://transcript-event / session-state push
// the instant path. Pre-2026-07-10 the main renderer ran FOUR 2.5s fd_sessions
// loops at once (this bridge + a poll per roster hook instance); that sustained
// IPC/alloc churn saturated the renderer toward its OOM crash page. The roster
// is now a per-window singleton and both loops breathe at 5s.
const POLL_MS = 5000;

/** FlowRunner driver → the visible peripheral agent chip that fronts it (fleet
 *  identity: Forge=Claude, Vega=Codex, Quill=Cursor). Used to attribute a flow
 *  lane's work to a real agent; unknown drivers spread by session hash. */
// DRIVER_AGENT now lives in realEvents.ts beside agentIdForDriver, so the flow
// lane and the session snapshot cannot drift apart on who represents which tool.
const HANDOFF_WINDOW_S = 5; // A ends, B starts in the same area within this → handoff

// The three shared PUSH-channel payloads (TranscriptEventPayload / SessionStatePayload /
// HermesEventPayload) and their translation now live in ./realEvents so the brain and the
// galaxy window can never drift. FlowStatePayload below is brain-only (flow-progress).

/** praxis://flow-progress payload - the full FlowState from the native FlowRunner
 *  (src-tauri/src/flow_runner.rs, camelCase serde). Only the fields the brain reads
 *  are typed here; the rest of the persisted state is ignored. */
interface FlowLanePayload {
  id: string;
  driver: string; // "claude" | "codex" | "cursor"
  prompt: string;
  cwd?: string | null;
  model?: string | null;
  /** "pending" | "running" | "verifying" | "retrying" | "done" | "failed-escalate" */
  status: string;
}
interface FlowWavePayload {
  label: string;
  status: string;
  lanes: FlowLanePayload[];
}
interface FlowStatePayload {
  flowId: string;
  label: string;
  /** "running" | "done" | "failed" | "halted" | "stopped" */
  status: string;
  waves: FlowWavePayload[];
}

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

export function useRealEvents(): void {
  useEffect(() => {
    // DEV: expose the PURE poll mappers so the headless harness can unit-test the
    // event synthesis without a Tauri backend (scripts/test-real-events.cjs).
    if (import.meta.env.DEV) {
      (window as unknown as { __praxisRealEvents?: unknown }).__praxisRealEvents = {
        diffSnapshots,
        flattenSnapshot,
        repoToArea,
        sessionToAgentId,
        anyRunning,
      };
    }
    if (!inTauri()) return; // browser / headless: bridge stays mock-only

    let prev: LanesSnapshot | null = null;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let mockTakenOver = false;
    // Flips true on the FIRST push event. From then on the push bus is the
    // authority and the poll stops synthesizing events (dedupe). Old builds with no
    // new Rust never flip it → the poll keeps its Phase-2a behavior (fallback).
    let pushAlive = false;
    // FlowRunner tracking (praxis://flow-progress): flows still running keep the mock
    // paused even when they don't surface as fd_sessions; laneStatus dedupes the
    // per-lane transitions we translate into task/agent/journey events.
    const runningFlows = new Set<string>();
    const laneStatus = new Map<string, string>(); // `${flowId}:${laneId}` → last status
    // Live flow-lane agents: `${flowId}:${laneId}` → agentId while that lane is running.
    // Feeds the per-poll reconcileFiring so a flow lane that's silently building for
    // minutes keeps its coder chip firing (and is dropped the instant the lane ends).
    const flowLaneAgents = new Map<string, string>();

    const nowT = () => performance.now() / 1000;

    // Stable area / agent / task per session (areaTask hits the cached graph).
    //
    // The agent comes from the session's DRIVER (the snapshot's lane), exactly as the
    // roster and flattenSnapshot attribute it - never `sessionToAgentId`'s hash pick
    // among the area's agents. That pick is what put "Lens - ⚙ Read" and "Vega - Bash"
    // on the brain's status line (2026-09-24) while the only thing working was the owner's
    // own Claude Code session. The push events (transcript tailer, session poller)
    // come from Claude Code's own session files, so an id the snapshot hasn't listed
    // yet is a Claude session: Forge.
    const agentBySession = new Map<string, string>();
    const meta = new Map<string, { area: string; agentId: string; taskId?: string }>();
    const metaFor = (sessionId: string, cwd: string) => {
      const agentId = agentBySession.get(sessionId) ?? agentIdForDriver("claude") ?? "a.forge";
      let m = meta.get(sessionId);
      if (!m) {
        const area = repoToArea(cwd);
        // explicit cwd-based milestone targeting (no hash-random) - spec §B.6
        m = { area, agentId, taskId: areaTask(area, sessionId, { cwd }) };
        meta.set(sessionId, m);
      } else if (m.agentId !== agentId) {
        m = { ...m, agentId };
        meta.set(sessionId, m);
      }
      return m;
    };

    // recently-stopped sessions, for area-handoff inference (A ends → B starts).
    const recentStops: Array<{ area: string; agentId: string; at: number }> = [];

    const pauseMockForReal = () => {
      if (!mockTakenOver) {
        usePraxisStore.getState().setPaused(true);
        mockTakenOver = true;
      }
    };

    // ── push handlers ──────────────────────────────────────────────────────────
    const onTranscript = (p: TranscriptEventPayload) => {
      pushAlive = true;
      pauseMockForReal();
      // Only a session actually working in one of the owner's project areas moves an agent
      // (areaForWorkspace); real work elsewhere still pauses the demo timeline above.
      if (!areaForWorkspace(p.cwd)) return;
      const m = metaFor(p.session_id, p.cwd);
      for (const e of transcriptEvents(p, m, nowT())) eventBus.emit(e);
    };

    const onSessionState = (p: SessionStatePayload) => {
      pushAlive = true;
      // Brain window pauses its mock timeline the instant a real session starts, and -
      // unlike the galaxy - also drives the Journey plan (emitJourneyStatus: true).
      if (p.running_after && !p.running_before) pauseMockForReal();
      if (!areaForWorkspace(p.cwd)) return; // not the owner's project work: no agent motion
      const m = metaFor(p.session_id, p.cwd);
      for (const e of sessionStateEvents(p, m, nowT(), {
        recentStops,
        handoffWindowS: HANDOFF_WINDOW_S,
        emitJourneyStatus: true,
      })) {
        eventBus.emit(e);
      }
      // free the per-session meta once it docks (session ended)
      if (!p.running_after && p.running_before) meta.delete(p.session_id);
    };

    // ── hermes-event handler ────────────────────────────────────────────────────
    // Translation lives in ./realEvents (hermesEvents) so it stays identical to the
    // galaxy window's copy; the brain adds only its own pushAlive + mock-pause. The
    // orchestrator anchor + every event shape are shared.
    const onHermesEvent = (p: HermesEventPayload) => {
      pushAlive = true;
      pauseMockForReal();
      for (const e of hermesEvents(p, nowT())) eventBus.emit(e);
    };

    // ── flow-progress handler (native FlowRunner → the brain) ───────────────────
    // The FlowRunner (src-tauri/src/flow_runner.rs) drives real headless agent
    // processes and emits praxis://flow-progress on every transition with the full
    // FlowState. Translate each lane's status TRANSITIONS into the same real (non-
    // synthetic) events a live session produces - so a native flow lights the brain,
    // moves the plan, and hands off exactly like a hand-launched session does.
    const onFlowProgress = (p: FlowStatePayload) => {
      pushAlive = true;
      const t = nowT();
      if (p.status === "running") {
        runningFlows.add(p.flowId);
        pauseMockForReal(); // keep reality driving even if lanes aren't fd_sessions
      } else {
        runningFlows.delete(p.flowId); // done | failed | halted | stopped
        // the whole flow ended → drop any of its lanes still tracked as live
        for (const key of [...flowLaneAgents.keys()]) {
          if (key.startsWith(`${p.flowId}:`)) flowLaneAgents.delete(key);
        }
      }
      for (const wave of p.waves ?? []) {
        for (const lane of wave.lanes ?? []) {
          const key = `${p.flowId}:${lane.id}`;
          const cur = lane.status;
          if (laneStatus.get(key) === cur) continue; // only act on a real transition
          laneStatus.set(key, cur);
          const cwd = lane.cwd ?? "";
          const area = repoToArea(cwd || p.label || "praxis");
          // explicit milestone targeting + real title from the lane's cwd + prompt; a
          // miss anchors at the repo/area level, never the leaky authored fallback.
          const { taskId, matched, title } = resolveTaskAndTitle(area, { cwd, text: lane.prompt });
          // A lane with no recognisable driver lights NO agent. It used to hash the
          // lane key into the area's agent list, which is how Quill ended up
          // orbiting Praxis while Cursor was closed.
          const agentId = agentIdForDriver(lane.driver);
          const model = lane.model ?? undefined;
          switch (cur) {
            case "running":
            case "retrying":
            case "verifying":
              // the lane's process is alive (verify still runs on the exited process) -
              // keep it firing across the poll heartbeat until the lane truly ends
              if (agentId) flowLaneAgents.set(key, agentId);
              break;
            case "done":
            case "failed-escalate":
              flowLaneAgents.delete(key);
              break;
            default:
              break;
          }
          switch (cur) {
            case "running":
            case "retrying":
              // An unattributed lane advances the PLAN but lights no agent - the
              // work is real, the worker is unknown, and naming one would be a guess.
              if (agentId) {
                eventBus.emit({ type: "agent:status", t, agentId, taskId, areaId: area, status: "working", model, label: title });
              }
              // ONLY a genuine match advances the plan - an unidentified lane must not fake it
              if (matched && taskId) {
                eventBus.emit({ type: "task:start", t, taskId, areaId: area });
                eventBus.emit({ type: "journey:status", t, taskId, areaId: area, journeyStatus: "active" });
              }
              break;
            case "verifying":
              // process exited, verify running → nearly done (real, not fabricated)
              if (matched && taskId) eventBus.emit({ type: "task:progress", t, taskId, areaId: area, progress: 0.85 });
              break;
            case "done":
              if (matched && taskId) {
                eventBus.emit({ type: "task:complete", t, taskId, areaId: area, agentId: agentId ?? undefined });
                eventBus.emit({ type: "journey:status", t, taskId, areaId: area, journeyStatus: "done" });
                // real advancement → flow the work product to the milestone it feeds
                const succ = journeySuccessor(taskId, usePraxisStore.getState().journey);
                if (succ) eventBus.emit({ type: "journey:handoff", t, taskId, nextId: succ, areaId: area });
              }
              if (agentId) eventBus.emit({ type: "agent:status", t, agentId, status: "idle" });
              break;
            case "failed-escalate":
              // a real failure: stop the working indicator + surface it honestly (NO
              // task:complete - it did not finish, and NO journey:status done)
              if (agentId) eventBus.emit({ type: "agent:status", t, agentId, status: "idle" });
              usePraxisStore.getState().notify(`Flow lane escalated — ${lane.id} (${p.label || p.flowId})`);
              break;
            default:
              break; // pending - nothing to show yet
          }
        }
      }
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
        const offF = await listen<FlowStatePayload>("praxis://flow-progress", (e) =>
          onFlowProgress(e.payload),
        );
        if (cancelled) {
          offT();
          offS();
          offH();
          offF();
        } else {
          unlisteners.push(offT, offS, offH, offF);
        }
      } catch {
        /* not in the Tauri shell - push bus simply absent; poll fallback covers it */
      }
    })();

    // ── coarse poll (mock-takeover toggle + Phase-2a fallback when push is absent) ─
    const poll = async () => {
      // Skip the fd_sessions IPC while the window is hidden (tray / backgrounded) -
      // this and shared/agents.ts were BOTH hitting the same heavy snapshot every
      // 2.5s forever. Keep the timer chain alive (cheap) so it self-heals on return;
      // onVisibilityChange below fires an immediate catch-up when we're visible again.
      if (!isVisible()) {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
        return;
      }
      try {
        const snap = await fetchLanes();
        const t = nowT(); // ONE timebase (performance.now()/1000) for every lastActive
        const store = usePraxisStore.getState();

        // real sessions OR a running native flow → let reality drive (pause mock);
        // none → restore the ambient mock. Including runningFlows means a FlowRunner
        // whose lanes aren't Flight Deck sessions still holds the mock off.
        const live = anyRunning(snap) || runningFlows.size > 0;
        if (live && !mockTakenOver) {
          store.setPaused(true);
          mockTakenOver = true;
        } else if (!live && mockTakenOver) {
          store.setPaused(false);
          mockTakenOver = false;
        }

        // Only synthesize events here when the richer push bus is NOT live (dedupe).
        if (!pushAlive) {
          for (const e of diffSnapshots(prev, snap, t)) eventBus.emit(e);
        }
        prev = snap;

        // ── ONE-TRUTH heartbeat (Flight Deck definition = running processes) ──────────
        // Agents backing a running fd session or flow lane are kept fresh; a
        // firing-eligible agent still "working" with no live session AND no recent event
        // decays out (FIRING_DECAY_S) - so the brain's FIRING count converges with the FD
        // instead of drifting up on a missed idle event. This is the single derivation
        // StateBar / Waveform read (via selectFiringAgents).
        const liveIds = new Set<string>();
        // Where each live agent is ACTUALLY working (its working sessions' anchors), so a
        // stale orbit can be pointed back at real work - see reconcileFiring.
        const liveAnchors = new Map<string, Array<{ areaId: string; taskId?: string; title?: string }>>();
        // WORKING, not merely running. `running` means the process is alive, which is
        // true of every Claude Code window the owner has left open - so the brain showed
        // agents orbiting Praxis while nothing was being processed, including one for
        // the very window he was typing his complaint in. The backend already draws
        // this distinction and says so in flightdeck.rs: an open-but-idle session
        // "still belongs on the deck (it is in the sidebar) - it just must not read
        // as, or orbit like, active work." The deck honoured that; the brain did not.
        // An agent working a FlowRunner lane is anchored by that lane; never re-point it
        // at an unrelated session.
        const flowAgents = new Set([...flowLaneAgents.values()].filter(Boolean));
        for (const fs of flattenSnapshot(snap).values()) {
          if (fs.agentId) agentBySession.set(fs.id, fs.agentId);
          if (fs.working && fs.agentId) {
            liveIds.add(fs.agentId);
            if (flowAgents.has(fs.agentId)) continue;
            const list = liveAnchors.get(fs.agentId) ?? [];
            list.push({ areaId: fs.area, taskId: fs.taskId, title: fs.title });
            liveAnchors.set(fs.agentId, list);
          }
        }
        for (const ag of flowLaneAgents.values()) if (ag) liveIds.add(ag);
        store.reconcileFiring([...liveIds], t, liveAnchors);
      } catch {
        /* snapshot unavailable this tick - retry next interval */
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    };
    poll();
    // Immediate catch-up snapshot the instant the window becomes visible again, so a
    // session that started/ended while we were in the tray reflects without waiting
    // for the next 2.5s tick.
    const offVis = onVisibilityChange((visible) => {
      if (!visible) return;
      // Cancel the pending tick before the catch-up so we don't spawn a 2nd timer chain.
      if (timer) clearTimeout(timer);
      void poll();
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      offVis();
      for (const off of unlisteners) off();
    };
  }, []);
}
