/**
 * realEvents - bridge REAL Claude-session activity into the brain's event stream.
 *
 * Phase 2a (NO new Rust): the Tauri backend already exposes a rich live snapshot via
 * `fd_sessions` (repos → lanes → sessions, each with running / role / mtime / preview).
 * `useRealEvents` polls it on an interval; `diffSnapshots` turns the delta between two
 * polls into the SAME flat PraxisEvent shapes the mock timeline emits - so the brain
 * lights the matching lobe, an agent travels there, the HUD ticker shows the real
 * session preview text, and the core speaks when an orchestrator session produces
 * output. Nothing downstream changes; this just swaps the event SOURCE.
 *
 * The richer signal - streaming assistant text → a precise voice envelope, tool_use →
 * fine-grained activity, real task inference from the transcript - needs a Rust
 * transcript tailer and is the queued follow-up. This is the working MVP over the
 * infrastructure that already ships.
 *
 * `diffSnapshots` / `flattenSnapshot` / `repoToArea` / `sessionToAgentId` are PURE +
 * deterministic so they unit-test without Tauri (exposed on window.__praxisRealEvents
 * in DEV; see scripts/test-real-events.cjs).
 */

import type { LanesSnapshot } from "@/flightdeck/types";
import type { PraxisEvent } from "./schema";
import { buildGraph } from "./graph";
import { AUTHORED_MILESTONES, areaActiveMilestone, milestoneForSignal } from "./journey";

/**
 * Map a repo (by root path / label) onto a brain initiative area (graph area-node id).
 * Heuristic for the MVP - a later pass can make this explicit per-lane config in the
 * vault. Defaults to the home initiative so a real session always lights SOME lobe.
 */
/**
 * Where a session is ACTUALLY working, or null when it is not one of the owner's project areas. Live
 * session -> agent motion uses this strict map; builds Praxis runs place their agents on their
 * mission node instead.
 */
export function areaForWorkspace(cwd: string): string | null {
  const s = (cwd || "").toLowerCase().replace(/\\/g, "/");
  if (!s.trim()) return null;
  // by folder NAME, not location: the Praxis repo, its lanes, Quartz and its design docs
  const segs = s.split("/").filter(Boolean);
  if (segs.includes("praxis-builds")) return null;
  if (segs.some((g) => g === "praxis" || g === "praxis-lanes" || g === "praxis-quartz" || g === "praxis (non-code)")) return "praxis";
  if (s.includes("catalyzed")) return "catalyzed";
  if (s.includes("studio")) return "studio";
  if (s.includes("trading-bot") || s.includes("financ") || s.includes("alpha-fund")) return "finance";
  if (s.includes("freelanc") || s.includes("client")) return "ventures";
  if (s.includes("learn") || s.includes("study")) return "learnai";
  return null;
}

export function repoToArea(repoRootOrLabel: string): string {
  const s = repoRootOrLabel.toLowerCase();
  if (s.includes("catalyzed")) return "catalyzed";
  if (s.includes("praxis") || s.includes("command-deck")) return "praxis";
  if (s.includes("studio")) return "studio";
  if (s.includes("trad")) return "finance";
  if (s.includes("financ") || s.includes("alpha-fund")) return "finance";
  if (s.includes("freelanc") || s.includes("client")) return "ventures";
  if (s.includes("learn") || s.includes("study") || s.includes("skill")) return "learnai";
  return "praxis";
}

/** Per-area agent preference (primary first). A session is bound to one of these by a
 *  stable hash, so concurrent sessions in one area spread across distinct agents.
 *  Uses the canonical fleet codenames from graph.ts AGENTS.
 *
 *  ONLY firing-eligible WORKER personas here (Forge/Vega/Quill coders + Lens QA). The
 *  ambient services (Atlas voice companion, Sage research-watch) and infra engine agents
 *  are DELIBERATELY excluded: a real coding session must never hash onto an ambient
 *  persona, because the roster rule (store.isFiringAgent) doesn't count Atlas/Sage as a
 *  firing coding agent - binding a session to one would make genuine work vanish from the
 *  FIRING count. Atlas/Sage still light up through their OWN paths (voice route / operator
 *  loop), which the count intentionally ignores. */
const AREA_AGENTS: Record<string, string[]> = {
  catalyzed:   ["a.forge", "a.vega", "a.quill", "a.lens"],
  praxis:      ["a.forge", "a.vega", "a.quill", "a.lens"],
  studio: ["a.vega", "a.quill", "a.lens", "a.forge"],
  finance:     ["a.vega", "a.forge", "a.lens", "a.quill"],
  trading:     ["a.vega", "a.forge", "a.lens"],
  ventures:    ["a.forge", "a.vega", "a.quill"],
  learn:       ["a.vega", "a.quill", "a.lens", "a.forge"],
  learnai:     ["a.vega", "a.quill", "a.lens", "a.forge"],
};

/** Deterministic 0..1 from a string (no Math.random - stable session→agent binding). */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** Bind a session to a stable agent within its area. */
export function sessionToAgentId(sessionId: string, areaId: string): string {
  const list = AREA_AGENTS[areaId] ?? ["a.scout"];
  return list[Math.floor(hash01(sessionId) * list.length) % list.length];
}

/** The ONE mapping from the tool that ran the work to the agent that represents it. */
export const DRIVER_AGENT: Record<string, string> = {
  claude: "a.forge",
  max: "a.forge",
  cloud: "a.forge",
  // The PRIMARY worktree lane is tagged "integration" rather than by tool, and its
  // sessions come from the Claude session store - Codex and Cursor are folded in as
  // their own synthetic lanes (`is_integration: false`) with explicit drivers. So
  // integration means Claude here. Without this line the main checkout, which is
  // where the owner actually works, would light no agent at all.
  integration: "a.forge",
  codex: "a.vega",
  cursor: "a.quill",
};

/** Codex and Cursor session cards are id-prefixed by the folder that built them. */
const ID_PREFIX_AGENT: Array<[string, string]> = [
  ["codex:", "a.vega"],
  ["cursor:", "a.quill"],
];

/**
 * Which agent is doing this work - or NULL when we genuinely cannot tell.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS REPLACES A HASH-RANDOM PICK THAT LIT THE WRONG AGENT ON THE BRAIN.
 *
 * `sessionToAgentId` chooses from the area's agent list by hashing the session
 * id. It is stable, so it never flickered - which is exactly why it survived: a
 * consistently wrong answer looks like a working feature.
 *
 * The owner saw both halves of it on the same screen.
 *
 * The session already knows its driver. Use it. When the driver is missing or
 * unrecognised we do not know who is working, and the honest render of that is
 * NOTHING - an unlit agent, not a plausible one. `areaTask` in this same file
 * already holds that line for milestones ("NEVER a hash-random pick"); agent
 * attribution just never got the same treatment.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function agentIdForDriver(driver?: string | null): string | null {
  return (driver && DRIVER_AGENT[driver]) || null;
}

/**
 * Who is working on this session, from the two signals that actually carry it:
 * the session id's own prefix (most specific - only Codex and Cursor cards have
 * one) and otherwise the lane's driver. Null when neither answers.
 */
export function agentIdForSession(sessionId: string, laneDriver?: string | null): string | null {
  for (const [prefix, agent] of ID_PREFIX_AGENT) {
    if (sessionId.startsWith(prefix)) return agent;
  }
  return agentIdForDriver(laneDriver);
}

/**
 * Resolve the milestone (task node) a real session/lane is advancing (spec §B.6).
 * Targeting order - NEVER a hash-random pick:
 *   1. the EXPLICIT signal map (cwd / branch / prompt keywords → MILESTONE_SIGNALS)
 *   2. the area's authored ACTIVE milestone (deterministic "you are here")
 *   3. the first task in the area (last-resort, still stable)
 * Uses AUTHORED_MILESTONES so it stays pure + deterministic (unit-testable without
 * the store); the ids are stable regardless of live status overrides. `sessionId`
 * is retained for signature compatibility (no longer used to hash-pick a task).
 */
export function areaTask(
  areaId: string,
  _sessionId: string,
  sig?: { cwd?: string; branch?: string; text?: string },
): string | undefined {
  const tasks = buildGraph().tasksByArea.get(areaId);
  if (!tasks || !tasks.length) return undefined;
  const inArea = new Set(tasks);
  // 1. explicit mapping - only accept a hit that lands in THIS area's task set
  if (sig) {
    const mapped = milestoneForSignal(sig, AUTHORED_MILESTONES);
    if (mapped && inArea.has(mapped)) return mapped;
  }
  // 2. the area's authored active/next/first milestone (deterministic)
  const active = areaActiveMilestone(areaId, AUTHORED_MILESTONES);
  if (active && inArea.has(active)) return active;
  // 3. stable last resort
  return tasks[0];
}

/**
 * The session's REAL, human task title - for the roster / ticker / feed, which read as
 * literal claims ("Forge → …"). NEVER a mechanism or authored-guess name (the CDP audit
 * found unmatched sessions leaking the internal "Live event bridge" milestone label).
 * Order:
 *   1. the git-branch leaf, prettified (the sharpest human label of what a session is on)
 *   2. else the repo / initiative display label (repo-level - "fall back to repo/branch")
 * Generic branch names (main/HEAD/worktree-…/agent-…) are skipped in favour of the repo.
 */
export function sessionTitle(
  sig: { branch?: string; cwd?: string },
  areaId?: string,
): string | undefined {
  const branch = (sig.branch ?? "").trim();
  if (branch) {
    const leaf = (branch.split("/").pop() ?? branch).replace(/[-_]+/g, " ").trim();
    const generic =
      /^(head|main|master|develop|dev|detached)$/i.test(leaf) ||
      /^worktree/i.test(leaf) ||
      /^agent[ -]/i.test(leaf);
    if (leaf && !generic) return leaf;
  }
  if (areaId) {
    const nd = buildGraph().byId.get(areaId);
    if (nd) return nd.label; // repo / initiative level - honest, never a mechanism name
  }
  return undefined;
}

/** Result of anchoring a real session to the plan + its real title (visual-truth). */
export interface SessionTaskAnchor {
  /** Node the agent attaches to (viz / camera fly-to): the matched milestone, else the
   *  REPO/AREA node - never the leaky authored "you are here" milestone. */
  taskId?: string;
  /** true iff `taskId` is a milestone matched from REAL signals (not a fallback). Callers
   *  gate task:start / journey:status(active) on this so an UNidentified session never
   *  fakes plan progress or misattributes itself to a specific milestone. */
  matched: boolean;
  /** The session's real human title (matched-milestone label, else branch/repo). */
  title?: string;
}

/**
 * Anchor a real session to a plan node + a real title. A GENUINE signal match
 * (branch / cwd / prompt → milestone) attaches to that milestone and carries its label.
 * With NO genuine match we attach at the REPO/AREA level (the area node) and carry the
 * repo-level title - deliberately NOT the area's authored active milestone, whose label
 * (e.g. the "Live event bridge" mechanism milestone) would misattribute an unrelated
 * session. Shared by both windows' session-state translation AND the poll-fallback /
 * brain flow-progress paths, so the roster can never drift.
 */
export function resolveTaskAndTitle(
  areaId: string,
  sig: { cwd?: string; branch?: string; text?: string },
): SessionTaskAnchor {
  const g = buildGraph();
  const inArea = new Set(g.tasksByArea.get(areaId) ?? []);
  const hasSignal = !!(sig.cwd || sig.branch || sig.text);
  const mapped = hasSignal ? milestoneForSignal(sig, AUTHORED_MILESTONES) : undefined;
  if (mapped && inArea.has(mapped)) {
    return { taskId: mapped, matched: true, title: g.byId.get(mapped)?.label };
  }
  const areaNode = g.byId.has(areaId) ? areaId : undefined;
  return { taskId: areaNode, matched: false, title: sessionTitle(sig, areaId) };
}

interface FlatSession {
  id: string;
  area: string;
  /**
   * The process is alive - the session is OPEN in Claude Code's sidebar. It may be
   * sitting idle waiting for the owner to type. This is not work.
   */
  running: boolean;
  /**
   * A prompt is genuinely being processed right now: the backend's `status === "live"`,
   * which means the process is alive AND the transcript's last turn is still open AND
   * that turn has written recently.
   *
   * This is the ONLY thing that should make an agent orbit a node.
   */
  working: boolean;
  build: boolean; // role === 'build' (edits files) vs passive (orchestrator/research)
  mtime: number;
  preview: string | null;
  /**
   * The agent representing the tool that ran this session, or NULL when the
   * driver is unknown. Null means "nobody is claimed to be working on it" and
   * every consumer must skip it rather than substituting a guess.
   */
  agentId: string | null;
  taskId?: string;
  /** true iff taskId is a genuine milestone match (gates plan advancement). */
  matched: boolean;
  /** the session's real human title (carried on agent:status as `label`). */
  title?: string;
}

/** Flatten a snapshot into per-session rows keyed by session id (pure). */
export function flattenSnapshot(snap: LanesSnapshot): Map<string, FlatSession> {
  const out = new Map<string, FlatSession>();
  for (const repo of snap.repos ?? []) {
    const cwd = repo.root || repo.label || "";
    const area = areaForWorkspace(cwd);
    if (!area) continue; // not where the owner's project work lives: never shown as Praxis work
    for (const lane of repo.lanes ?? []) {
      for (const s of lane.sessions ?? []) {
        // explicit mapping (cwd + live preview text) → milestone + real title; a miss
        // anchors at the repo/area level, never the leaky authored fallback milestone.
        const anchor = resolveTaskAndTitle(area, { cwd, text: s.preview ?? undefined });
        out.set(s.id, {
          id: s.id,
          area,
          running: !!s.running,
          working: s.status === "live",
          build: s.role === "build",
          mtime: s.mtime ?? 0,
          preview: s.preview ?? null,
          agentId: agentIdForSession(s.id, lane.driver),
          taskId: anchor.taskId,
          matched: anchor.matched,
          title: anchor.title,
        });
      }
    }
  }
  return out;
}

/**
 * Turn the delta between two snapshots into PraxisEvents (pure + deterministic given
 * prev, next, now). `now` is the loop-seconds stamp to put on the events.
 */
export function diffSnapshots(
  prev: LanesSnapshot | null,
  next: LanesSnapshot,
  now: number,
): PraxisEvent[] {
  const events: PraxisEvent[] = [];
  const cur = flattenSnapshot(next);
  const old = prev ? flattenSnapshot(prev) : new Map<string, FlatSession>();

  const started: FlatSession[] = [];
  const stopped: FlatSession[] = [];

  // WORKING drives motion, not RUNNING. `running` only says the process is alive, which
  // is true of every session the desktop app keeps open; this fallback used it, so the
  // first poll after a window opened (prev = null) sent an agent to orbit every open
  // session at once. Live 2026-10-04 that was Forge circling an Studio session
  // nobody had touched since 09-30, while the owner had nothing running. Everywhere else
  // already keys on `working` (flattenSnapshot: status "live" = a turn in progress).
  for (const [id, s] of cur) {
    const was = old.get(id);
    const wasWorking = was?.working ?? false;
    if (s.working && !wasWorking) {
      // a session started a turn → its agent flies to the lobe and starts working, carrying
      // its REAL title (never the mechanism-name fallback). An UNATTRIBUTED session
      // (no recognisable driver) lights no agent: the task events below still fire,
      // because the work is real even when we cannot name who is doing it.
      if (s.agentId) events.push({
        type: "agent:status",
        t: now,
        agentId: s.agentId,
        taskId: s.taskId,
        areaId: s.area,
        status: "working",
        label: s.title,
      });
      // real task activity - mirror of the push bus's task:start (see useRealEvents).
      // ONLY a genuine milestone match advances the plan; an unidentified session
      // (anchored at the repo/area level) must not fake task/plan progress.
      if (s.matched && s.taskId) {
        events.push({ type: "task:start", t: now, taskId: s.taskId, areaId: s.area });
        // real session → mapped milestone reads ACTIVE on the plan (spec §B.5b);
        // applyEvent won't reopen a done milestone from this soft signal
        events.push({ type: "journey:status", t: now, taskId: s.taskId, areaId: s.area, journeyStatus: "active" });
      }
      started.push(s);
    } else if (!s.working && wasWorking) {
      if (s.agentId) events.push({ type: "agent:status", t: now, agentId: s.agentId, status: "idle" });
      stopped.push(s);
    } else if (s.working && wasWorking && s.mtime > (was?.mtime ?? 0)) {
      // still running, fresh activity since last poll → a "thought" beat (real preview
      // text in the ticker); an orchestrator/passive session producing prose also
      // makes the core SPEAK
      if (s.preview && s.agentId) {
        events.push({
          type: "agent:thinking",
          t: now,
          agentId: s.agentId,
          taskId: s.taskId,
          areaId: s.area,
          thought: s.preview.slice(0, 80),
        });
      }
      if (!s.build && s.preview) {
        events.push({
          type: "orchestrator:speaking",
          t: now,
          duration: Math.min(4.5, Math.max(1.4, s.preview.length * 0.02)),
        });
      }
    }
  }

  // a working session gone from the snapshot now → its agent went idle
  for (const [id, s] of old) {
    if (s.working && !cur.has(id)) {
      if (s.agentId) events.push({ type: "agent:status", t: now, agentId: s.agentId, status: "idle" });
      stopped.push(s);
    }
  }

  // HANDOFF: a build session stopped and a DIFFERENT build session started in the
  // SAME area this tick → the work passed hands (agent → agent packet).
  for (const off of stopped) {
    // A handoff is a claim about TWO agents; if either end is unattributed there
    // is no packet to draw between them.
    if (!off.build || !off.agentId) continue;
    const pickUp = started.find(
      (s) => s.build && s.agentId && s.area === off.area && s.agentId !== off.agentId,
    );
    if (pickUp && pickUp.agentId) {
      events.push({
        type: "agent:handoff",
        t: now,
        agentId: off.agentId,
        toAgentId: pickUp.agentId,
        areaId: off.area,
        taskId: pickUp.taskId,
      });
    }
  }

  return events;
}

/** True iff any session in the snapshot is running (drives the mock-timeline takeover). */
export function anyRunning(snap: LanesSnapshot): boolean {
  for (const repo of snap.repos ?? []) {
    for (const lane of repo.lanes ?? []) {
      for (const s of lane.sessions ?? []) if (s.running) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED PUSH-CHANNEL TRANSLATION (Phase 2b)
//
// The Rust real-event bus emits three push channels - praxis://transcript-event,
// praxis://session-state, praxis://hermes-event - and BOTH the brain window
// (useRealEvents.ts) and the galaxy window (useGalaxyRealEvents.ts, a separate
// webview bundle with its own eventBus singleton) translate those payloads into the
// SAME flat PraxisEvent shapes. These pure functions are the ONE translation truth
// so the two windows can never drift. Each hook keeps only its window-specific wiring
// (its own eventBus emit, mock-pause / pushAlive tracking, session-meta map, and - in
// the brain - the journey succession + flow-progress channel).
//
// PURE + deterministic given (payload, meta, t): no eventBus, no store, no clock.
// ─────────────────────────────────────────────────────────────────────────────

/** Push payloads from the Rust bus - snake_case to match the Tauri emit() fields
 *  (src-tauri/src/transcript_tailer.rs / session_poller.rs). */
export interface TranscriptEventPayload {
  session_id: string;
  cwd: string;
  event_type: string; // "assistant" | "tool_use"
  model: string | null;
  content: string | null;
  tool_name: string | null;
  git_branch: string | null;
  timestamp: number;
}
export interface SessionStatePayload {
  session_id: string;
  cwd: string;
  running_before: boolean;
  running_after: boolean;
  model: string | null;
  timestamp: number;
}
/**
 * Hermes event payload - emitted by the Rust hermes_brain / agent_delegate commands
 * on the `praxis://hermes-event` channel. snake_case matches the Tauri emit().
 */
export interface HermesEventPayload {
  /** Discriminator: tool.start | tool.complete | subagent.start | subagent.complete |
   *  status.update | reasoning.start | reasoning.delta | reasoning.complete |
   *  thinking.delta | message.start | message.delta | message.complete */
  kind: string;
  session_id: string;
  text?: string;
  tool_name?: string;
  model?: string;
  subagent_id?: string;
  parent_id?: string;
  depth?: number;
}

/** Resolved per-session anchor (area / agent / milestone) each hook computes from its
 *  own cached `meta` map before calling the shared translators. */
export interface SessionMeta {
  area: string;
  agentId: string;
  taskId?: string;
}

/** Hermes anchor - the orchestrator task node on the praxis cluster. Every Hermes
 *  event routes through here so resolveTarget finds a real node. */
export const HERMES_AREA = "praxis";
export const HERMES_TASK = "t.praxis.orchestrator";

/**
 * praxis://transcript-event → PraxisEvents. Assistant prose → the agent thinks (ticker)
 * AND the core speaks (voice ripple); tool_use → a fine-grained activity beat.
 * The word-rate estimate (~2.6 words/s ≈ 156 wpm, floor 1.2s, cap 6s) is truer than
 * chars*0.02. Identical in both windows.
 */
export function transcriptEvents(
  p: TranscriptEventPayload,
  m: SessionMeta,
  t: number,
): PraxisEvent[] {
  const events: PraxisEvent[] = [];
  if (p.event_type === "assistant" && p.content) {
    events.push({
      type: "agent:thinking",
      t,
      agentId: m.agentId,
      taskId: m.taskId,
      areaId: m.area,
      thought: p.content.slice(0, 80),
    });
    // word-rate estimate (~2.6 words/s ≈ 156 wpm) - truer than chars*0.02.
    const words = p.content.trim().split(/\s+/).filter(Boolean).length;
    const duration = Math.min(6, Math.max(1.2, words / 2.6));
    events.push({ type: "orchestrator:speaking", t, duration });
  } else if (p.event_type === "tool_use") {
    events.push({
      type: "agent:thinking",
      t,
      agentId: m.agentId,
      taskId: m.taskId,
      areaId: m.area,
      thought: p.tool_name ? `⚙ ${p.tool_name}` : "working…",
    });
  }
  return events;
}

/**
 * praxis://session-state → PraxisEvents. running↑ → the agent flies in and works (+ its
 * milestone reads ACTIVE); running↓ → the agent docks idle. Area-handoff inference reads
 * and mutates the caller's `recentStops` ring (A ends → a DIFFERENT B starts in-area
 * within `handoffWindowS`).
 *
 * Window difference PARAMETERIZED, not unified: the brain window also drives the Journey
 * plan, so it passes `emitJourneyStatus: true` to fire journey:status(active) on start;
 * the galaxy window has no plan and passes `false`. The caller still owns its own
 * pushAlive / mock-pause and the meta-map delete on session end.
 */
export function sessionStateEvents(
  p: SessionStatePayload,
  m: SessionMeta,
  t: number,
  ctx: {
    recentStops: Array<{ area: string; agentId: string; at: number }>;
    handoffWindowS: number;
    emitJourneyStatus: boolean;
  },
): PraxisEvent[] {
  const events: PraxisEvent[] = [];
  if (p.running_after && !p.running_before) {
    // a session came alive → its agent flies in and starts working. Anchor + REAL title
    // from the session's OWN signals (cwd) - never the leaky authored "you are here"
    // milestone (whose label would misattribute an unrelated session). `matched` gates
    // plan advancement so an unidentified session can't fake it.
    const { taskId, matched, title } = resolveTaskAndTitle(m.area, { cwd: p.cwd });
    events.push({
      type: "agent:status",
      t,
      agentId: m.agentId,
      taskId,
      areaId: m.area,
      status: "working",
      model: p.model ?? undefined, // real transcript model → per-model chip tint
      label: title,
    });
    // REAL task activity: a genuinely-matched live session marks its task ACTIVE so the
    // flow beads + cluster ring presence ride reality. Deliberately NO task:complete on
    // session end - a session stopping is not the task finishing.
    if (matched && taskId) {
      events.push({ type: "task:start", t, taskId, areaId: m.area });
      if (ctx.emitJourneyStatus) {
        // real session activity → the mapped milestone reads ACTIVE on the journey
        // plan (spec §B.5b). applyEvent guards against reopening a "done" milestone.
        events.push({
          type: "journey:status",
          t,
          taskId,
          areaId: m.area,
          journeyStatus: "active",
        });
      }
    }
    // handoff: a DIFFERENT agent finished in this area within the window
    const cutoff = t - ctx.handoffWindowS;
    while (ctx.recentStops.length && ctx.recentStops[0].at < cutoff) ctx.recentStops.shift();
    const partner = ctx.recentStops.find((r) => r.area === m.area && r.agentId !== m.agentId);
    if (partner) {
      events.push({
        type: "agent:handoff",
        t,
        agentId: partner.agentId,
        toAgentId: m.agentId,
        areaId: m.area,
        taskId,
      });
    }
  } else if (!p.running_after && p.running_before) {
    // session ended → its agent docks (idle)
    events.push({ type: "agent:status", t, agentId: m.agentId, status: "idle" });
    ctx.recentStops.push({ area: m.area, agentId: m.agentId, at: t });
  }
  return events;
}

/**
 * praxis://hermes-event → PraxisEvents. Maps the rich Hermes event stream to flat shapes.
 * All events use 'a.hermes' as the actor unless a subagent_id is present (then that
 * subagent is the actor and 'a.hermes'/parent_id is the handoff source). Every event is
 * anchored at HERMES_TASK/HERMES_AREA so resolveTarget finds a real node. Identical in
 * both windows. Note the message.delta voice floor is 0.8s (vs 1.2s for a full assistant
 * turn in transcriptEvents) - a streaming delta is a shorter envelope.
 */
export function hermesEvents(p: HermesEventPayload, t: number): PraxisEvent[] {
  const events: PraxisEvent[] = [];
  const agentId = p.subagent_id ?? "a.hermes";
  const taskId = HERMES_TASK;
  const areaId = HERMES_AREA;

  switch (true) {
    // ── tool activity ──────────────────────────────────────────────────────
    case p.kind === "tool.start":
      events.push({
        type: "agent:thinking",
        t,
        agentId,
        taskId,
        areaId,
        thought: p.tool_name ? `⚙ ${p.tool_name}` : "⚙ tool running…",
      });
      events.push({ type: "agent:status", t, agentId, taskId, areaId, status: "working", model: p.model });
      break;

    case p.kind === "tool.complete":
      // A finished TOOL is not a finished MILESTONE. This used to emit
      // task:complete against HERMES_TASK ("t.praxis.orchestrator"), so every
      // file read and every grep Hermes ran flipped a roadmap milestone to
      // complete/100% and printed "Orchestrator mock · complete" in the feed,
      // over and over. Anchoring Hermes to a node is fine; asserting a milestone
      // shipped is not. The neighbouring subagent.complete case already gets this
      // right, which is why this reads as a copy-paste rather than a decision.
      events.push({
        type: "agent:thinking",
        t,
        agentId,
        taskId,
        areaId,
        thought: `✓ ${p.tool_name ?? "tool"}`,
      });
      events.push({ type: "agent:status", t, agentId, taskId, areaId, status: "idle" });
      break;

    // ── subagent lifecycle ─────────────────────────────────────────────────
    case p.kind === "subagent.start": {
      events.push({ type: "agent:status", t, agentId, taskId, areaId, status: "working", model: p.model });
      // if there is a parent, visualise a handoff from parent → child
      const parentId = p.parent_id ?? "a.hermes";
      if (parentId !== agentId) {
        events.push({ type: "agent:handoff", t, agentId: parentId, toAgentId: agentId, taskId, areaId });
      }
      break;
    }

    case p.kind === "subagent.complete":
      events.push({ type: "agent:status", t, agentId, taskId, areaId, status: "done" });
      // hand back to parent (or hermes) when the subagent finishes
      if (p.parent_id && p.parent_id !== agentId) {
        events.push({ type: "agent:handoff", t, agentId, toAgentId: p.parent_id, taskId, areaId });
      }
      break;

    // ── thinking / reasoning deltas (stream) ──────────────────────────────
    case p.kind === "thinking.delta":
    case p.kind === "reasoning.delta":
    case p.kind === "reasoning.start":
      if (p.text) {
        events.push({
          type: "agent:thinking",
          t,
          agentId,
          taskId,
          areaId,
          thought: p.text.slice(0, 80),
        });
      }
      break;

    case p.kind === "reasoning.complete":
      // reasoning done → agent is still working but quiet
      events.push({ type: "agent:status", t, agentId, taskId, areaId, status: "working", model: p.model });
      break;

    // ── status / generic updates ───────────────────────────────────────────
    case p.kind === "status.update":
      if (p.text) {
        events.push({
          type: "agent:thinking",
          t,
          agentId,
          taskId,
          areaId,
          thought: p.text.slice(0, 80),
        });
      }
      break;

    // ── message stream (Praxis speaking) ──────────────────────────────────
    case p.kind === "message.start":
      events.push({ type: "agent:status", t, agentId, taskId, areaId, status: "working", model: p.model });
      break;

    case p.kind === "message.delta":
      if (p.text) {
        events.push({
          type: "agent:thinking",
          t,
          agentId,
          taskId,
          areaId,
          thought: p.text.slice(0, 80),
        });
        // fire the Praxis voice ripple; word-rate ~2.6 w/s
        const words = p.text.trim().split(/\s+/).filter(Boolean).length;
        const duration = Math.min(6, Math.max(0.8, words / 2.6));
        events.push({ type: "orchestrator:speaking", t, duration });
      }
      break;

    case p.kind === "message.complete":
      events.push({ type: "agent:status", t, agentId, taskId, areaId, status: "idle" });
      break;

    default:
      // unknown kind - emit a generic thinking event if there is text
      if (p.text) {
        events.push({ type: "agent:thinking", t, agentId, taskId, areaId, thought: p.text.slice(0, 80) });
      }
  }
  return events;
}
