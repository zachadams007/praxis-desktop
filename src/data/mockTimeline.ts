/**
 * The scripted mock event stream - a FALLBACK ambient-life track, not real work.
 *
 * HARD RULE (Phase 1): no API, no spend - when there is genuinely no real agent
 * running, the brain should still feel alive, so this deterministic, looping
 * timeline plays a fabricated "agent working on X" story and BrainRuntime pauses it
 * the moment `useRealEvents` detects real activity (see usePraxisStore.paused).
 *
 * IMPORTANT (spec A.2, 2026-07-06): this timeline's `agent:status: working` events
 * are decorative filler, not real work - a node must only become always-visible and
 * only gets an orbiting agent when a REAL agent (the real-event bridge / Hermes) is
 * actually working it in an active cluster. BrainRuntime tags every event emitted
 * from this player (`this.mockTick`) so it can flag the resulting AgentRT.real =
 * false; AgentField and the NodeField LOD reveal both gate on that flag, so this
 * mock can keep the brain's ambient pulses/glow alive without ever asserting a fake
 * "agent orbiting node" - that read is reserved for genuine activity.
 *
 * Generated once from the graph; a player emits due events onto the eventBus as
 * wall-clock advances, wrapping at the loop boundary. Swap this module for the real
 * Rust event bus later and nothing else in the brain changes.
 */

import type { PraxisEvent } from "./schema";
import { buildGraph, type Graph } from "./graph";

export const LOOP_SECONDS = 82;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per-role thought lines (HUD ticker + transient node label). Kept short.
// Keys match AgentDef.role strings from graph.ts AGENTS.
const THOUGHTS: Record<string, string[]> = {
  Orchestrator: ["Routing task…", "Delegating to fleet", "Watching the build", "Holding context"],
  "Claude Coder": [
    "Refactoring scorer…",
    "Wiring the data path",
    "Typecheck is green",
    "Patching edge case",
    "Running the build",
  ],
  "Codex Coder": [
    "Applying the diff…",
    "Running codex exec",
    "Patching imports",
    "Build passing",
  ],
  "Cursor Coder": [
    "Composing the edit…",
    "Tab-completing types",
    "Refining the component",
    "Syncing context",
  ],
  Operator: [
    "Clicking the button…",
    "Reading the screen",
    "Filling the form",
    "Navigating UI",
  ],
  Research: [
    "Scanning sources…",
    "Cross-checking claims",
    "Summarizing findings",
    "Pulling comparables",
    "Reading the diff",
  ],
  QA: [
    "Running the suite…",
    "Checking edge cases",
    "Verifying output",
    "Flagging a regression",
  ],
  Records: [
    "Re-ranking universe…",
    "Backtesting window",
    "Updating the ledger",
    "Reconciling positions",
  ],
  Router: ["Routing handoff…", "Queuing the packet", "Bridging sessions", "Relaying context"],
  "Brain Engine": ["Processing stream…", "Dispatching subagent", "Holding the thread", "Orchestrating"],
};

// Bias each agent's role toward the areas where that work naturally lands.
const ROLE_AREA_BIAS: Record<string, Record<string, number>> = {
  Orchestrator:  { praxis: 2.0, catalyzed: 1.0, finance: 0.8, studio: 0.6, learnai: 0.5, ventures: 0.5 },
  "Claude Coder":{ praxis: 1.6, catalyzed: 1.5, studio: 0.7, finance: 0.9, learnai: 0.6, ventures: 0.6 },
  "Codex Coder": { praxis: 1.6, catalyzed: 1.5, studio: 0.7, finance: 0.9, learnai: 0.7, ventures: 0.6 },
  "Cursor Coder":{ praxis: 1.5, catalyzed: 1.4, studio: 0.8, finance: 0.7, learnai: 0.7, ventures: 0.5 },
  Operator:      { praxis: 1.4, catalyzed: 1.2, studio: 1.0, finance: 0.8, learnai: 0.6, ventures: 0.5 },
  Research:      { catalyzed: 1.2, praxis: 1.1, studio: 1.0, finance: 1.0, learnai: 0.9, ventures: 0.7 },
  QA:            { praxis: 1.5, catalyzed: 1.3, studio: 0.7, finance: 0.8, learnai: 0.6, ventures: 0.5 },
  Records:       { finance: 1.9, catalyzed: 1.4, praxis: 0.8, studio: 0.4, learnai: 0.5, ventures: 0.9 },
  Router:        { praxis: 1.4, catalyzed: 0.9, studio: 1.0, finance: 0.9, learnai: 0.7, ventures: 0.8 },
  "Brain Engine":{ praxis: 2.0, catalyzed: 1.0, finance: 0.8, studio: 0.6, learnai: 0.6, ventures: 0.5 },
};

function pickWeighted<T>(items: T[], weights: number[], r: number): T {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r * total;
  for (let i = 0; i < items.length; i++) {
    x -= weights[i];
    if (x <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * Which model each persona runs in the demo, so the agents read as identifiable by
 * model out of the box. Real sessions override this with the live transcript model.
 * Matches the canonical fleet codenames from graph.ts AGENTS.
 */
const MOCK_AGENT_MODEL: Record<string, string> = {
  "a.praxis":  "hermes",           // Orchestrator → brain engine
  "a.forge":   "claude-opus-4-8",  // Claude Coder → flagship
  "a.vega":    "codex",            // Codex Coder → Codex CLI
  "a.quill":   "cursor",           // Cursor Coder → Cursor Composer
  "a.atlas":   "codex",            // Operator → Codex computer-use
  "a.sage":    "claude-sonnet-4-6",// Research → workhorse
  "a.lens":    "claude-sonnet-5",  // QA → fast
  "a.ledger":  "claude-sonnet-4-6",// Records → workhorse
  "a.relay":   "claude-sonnet-5",  // Router → fast
  "a.hermes":  "hermes",           // Brain Engine → brain engine
};

export function buildTimeline(g: Graph = buildGraph()): PraxisEvent[] {
  const ev: PraxisEvent[] = [];
  const rng = mulberry32(20260611);

  // Detail nodes per task, for memory/file birth events.
  const detailsByTask = new Map<string, { id: string; kind: string; label: string }[]>();
  for (const n of g.nodes) {
    if (n.tier === 3 && n.parentId) {
      const arr = detailsByTask.get(n.parentId) ?? [];
      arr.push({ id: n.id, kind: n.kind, label: n.label });
      detailsByTask.set(n.parentId, arr);
    }
  }

  const areaIds = [...g.tasksByArea.keys()];

  for (const agent of g.agents) {
    const bias = ROLE_AREA_BIAS[agent.role] ?? {};
    const thoughts = THOUGHTS[agent.role] ?? ["Working…"];
    let t = rng() * 9; // staggered entrance
    let lastTask = "";

    while (t < LOOP_SECONDS - 7) {
      // choose an area (role-biased), then a task within it
      const weights = areaIds.map((a) => bias[a] ?? 1);
      const areaId = pickWeighted(areaIds, weights, rng());
      const tasks = g.tasksByArea.get(areaId) ?? [];
      if (tasks.length === 0) {
        t += 3;
        continue;
      }
      let taskId = tasks[Math.floor(rng() * tasks.length)];
      if (taskId === lastTask && tasks.length > 1) {
        taskId = tasks[(tasks.indexOf(taskId) + 1) % tasks.length];
      }
      lastTask = taskId;

      const dur = 6 + rng() * 7;
      const start = t;
      const end = t + dur;

      // attach + task start
      ev.push({ type: "agent:status", t: start, agentId: agent.id, taskId, areaId, status: "working", model: MOCK_AGENT_MODEL[agent.id] });
      ev.push({ type: "task:start", t: start + 0.05, taskId, areaId });

      // thinking + progress beats
      const steps = 3 + Math.floor(rng() * 3);
      for (let s = 0; s < steps; s++) {
        const k = ((s + 1) / (steps + 1)) * dur;
        ev.push({
          type: "agent:thinking",
          t: start + k - 0.2,
          agentId: agent.id,
          taskId,
          areaId,
          thought: thoughts[Math.floor(rng() * thoughts.length)],
        });
        ev.push({
          type: "task:progress",
          t: start + k,
          taskId,
          areaId,
          progress: (s + 1) / steps,
        });
      }

      // sometimes write a memory or birth a file on one of the task's details
      const details = detailsByTask.get(taskId) ?? [];
      if (details.length && rng() < 0.7) {
        const d = details[Math.floor(rng() * details.length)];
        const at = start + dur * (0.4 + rng() * 0.4);
        if (d.kind === "file") {
          ev.push({
            type: "file:created",
            t: at,
            agentId: agent.id,
            taskId,
            areaId,
            nodeId: d.id,
            label: d.label,
            path: `C\\Users\\dev\\Desktop\\agent-output\\${d.label}`,
          });
        } else {
          ev.push({
            type: "memory:updated",
            t: at,
            agentId: agent.id,
            taskId,
            areaId,
            nodeId: d.id,
            label: d.label,
          });
        }
      }

      // complete + release
      ev.push({ type: "task:progress", t: end - 0.1, taskId, areaId, progress: 1 });
      ev.push({ type: "task:complete", t: end, taskId, areaId, agentId: agent.id });
      ev.push({ type: "agent:status", t: end + 0.15, agentId: agent.id, taskId, areaId, status: "done" });
      ev.push({ type: "agent:status", t: end + 1.0, agentId: agent.id, status: "idle" });

      t = end + 1.2 + rng() * 3.5;
    }
  }

  // --- agent → agent handoffs ----------------------------------------------
  // When one agent FINISHES in an area and a DIFFERENT agent picks up work in
  // the SAME area shortly after, that reads as a real information handoff - so
  // we draw a packet travelling along the edge between the two chips. Tied to
  // genuine task transitions (never decorative) and fully seeded, so the same
  // loop replays identically for filmable footage.
  const hrng = mulberry32(0x4a9d2026);
  const dones = ev.filter((e) => e.type === "agent:status" && e.status === "done");
  const works = ev.filter((e) => e.type === "agent:status" && e.status === "working");
  const handoffs: PraxisEvent[] = [];
  for (const d of dones) {
    const pick = works.find(
      (w) => w.areaId === d.areaId && w.agentId !== d.agentId && w.t > d.t && w.t <= d.t + 7,
    );
    if (!pick) continue;
    if (hrng() > 0.72) continue; // keep them occasional - a beat, not a stream
    handoffs.push({
      type: "agent:handoff",
      t: d.t + 0.3,
      agentId: d.agentId, // the sender (just finished)
      toAgentId: pick.agentId, // the receiver (about to start)
      areaId: d.areaId,
      taskId: pick.taskId,
    });
  }
  ev.push(...handoffs);

  // --- milestone → milestone journey handoffs ------------------------------
  // When a milestone COMPLETES, the work it produced feeds the NEXT milestone
  // down its lane on the roadmap. In the time-corridor (journey) view that reads
  // as a warm packet flowing along the plan from the finished node to the one it
  // unlocks. Tied to real completions + seeded; the runtime gates it on the morph
  // so it only appears in journey mode and never clutters the brain view.
  const jrng = mulberry32(0x6d3a2026);
  const jhandoffs: PraxisEvent[] = [];
  for (const c of ev) {
    if (c.type !== "task:complete" || !c.taskId || !c.areaId) continue;
    const lane = g.tasksByArea.get(c.areaId) ?? [];
    const at = lane.indexOf(c.taskId);
    const next = at >= 0 ? lane[at + 1] : undefined;
    if (!next) continue;
    if (jrng() > 0.45) continue; // occasional - a beat along the corridor, not a stream
    jhandoffs.push({
      type: "journey:handoff",
      t: c.t + 0.45,
      taskId: c.taskId, // from milestone (just completed)
      nextId: next, // to milestone (the next stop it feeds)
      areaId: c.areaId,
    });
  }
  ev.push(...jhandoffs);

  // SOURCE TAG (spec §A.1): every event this timeline produces is DECORATIVE ambient
  // filler, not real work. Tag them all `synthetic` so the literal-fact consumers
  // (StateBar counts + EXECUTING, Waveform ripple, the roster/feed reducer) can stay
  // quiet when nothing real is live, while the ambient brain glow/pulses still ride
  // these events. Set once here (and re-asserted in the BrainRuntime player) so the
  // whole mock stream - including the handoffs appended above - is honestly labelled.
  for (const e of ev) e.synthetic = true;

  ev.sort((a, b) => a.t - b.t);
  return ev;
}

/**
 * A looping player. Each `update(now)` emits every event whose scheduled `t` fell
 * between the previous frame's phase and this one, wrapping cleanly at LOOP_SECONDS.
 */
export function makePlayer(timeline: PraxisEvent[], emit: (e: PraxisEvent) => void) {
  let startedAt = -1;
  let lastPhase = 0;

  const emitRange = (lo: number, hi: number) => {
    // (lo, hi] - events strictly after lo, up to and including hi
    for (const e of timeline) {
      if (e.t > lo && e.t <= hi) emit(e);
      else if (e.t > hi) break;
    }
  };

  return {
    /** now = seconds (e.g. performance.now()/1000 or the r3f clock). */
    update(now: number) {
      if (startedAt < 0) {
        startedAt = now;
        lastPhase = 0;
        return;
      }
      const phase = (now - startedAt) % LOOP_SECONDS;
      if (phase >= lastPhase) {
        emitRange(lastPhase, phase);
      } else {
        // wrapped this frame
        emitRange(lastPhase, LOOP_SECONDS);
        emitRange(-0.0001, phase);
      }
      lastPhase = phase;
    },
    reset() {
      startedAt = -1;
      lastPhase = 0;
    },
  };
}
