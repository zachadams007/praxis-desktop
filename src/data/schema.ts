/**
 * The Praxis event schema - a flat, JSON-serializable contract.
 *
 * In Phase 1 these events come from a scripted mock timeline. In a later phase the
 * exact same shapes are emitted by the real Rust event bus (agent runtime + file
 * watcher), and the brain - which is just a subscriber that maps events → animations
 * - does not change. Keep this flat and boring on purpose.
 */

export type PraxisEventType =
  | "agent:status" // an agent changed status; may re-attach to a new task
  | "agent:thinking" // an agent emitted a transient thought
  | "agent:handoff" // one agent feeds info to another (agentId = from, toAgentId = to)
  | "task:start" // a task became active
  | "task:progress" // a task advanced (0..1)
  | "task:complete" // a task finished
  | "task:stop" // a task stopped without finishing (failed or queued) - no longer active, not done
  | "memory:updated" // a memory/doc node was written (ripple to memory)
  | "file:created" // a file node was born (file-birth visualizer)
  | "orchestrator:speaking" // the core "speaks" (Praxis voice waveform); duration secs
  | "journey:handoff" // work flows along the roadmap from one milestone to the next (taskId = from, nextId = to)
  | "journey:sprout" // a brain-dump milestone was filed onto the journey (nodeId = new task; taskId = the milestone it follows on its branch, if any)
  | "journey:status"; // a milestone's plan status changed from REAL work (taskId = milestone, journeyStatus = new status)

export type AgentStatus = "idle" | "working" | "done";

export interface PraxisEvent {
  /** Mission node data travels with its sprout so other windows can resolve it before dispatch. */
  missionNode?: { id: string; areaId: string; label: string; status: "done" | "active" | "next" | "later"; order: number; sprouted?: boolean };
  /** True only for events emitted by the monitored orchestration loop. */
  orchestrator?: boolean;
  /** Discriminator. */
  type: PraxisEventType;
  /** Seconds from the start of the timeline loop. */
  t: number;

  /** Acting agent (agent:* events). For agent:handoff this is the SENDER. */
  agentId?: string;
  /** agent:handoff - the RECEIVING agent the information flows to. */
  toAgentId?: string;
  /** Task this event concerns (task:* and agent attach). */
  taskId?: string;
  /** Initiative/area this rolls up to (denormalized for fast routing). */
  areaId?: string;
  /** Generic deeper target - a detail/doc/memory/file node id. */
  nodeId?: string;

  /** agent:status - the new status. */
  status?: AgentStatus;
  /** task:progress - 0..1. */
  progress?: number;
  /** agent:thinking - short thought text (HUD ticker + node label). */
  thought?: string;
  /** Human label (file name, task title override). */
  label?: string;
  /** file:created - real local path (Phase-1 file-birth panel; opens on click). */
  path?: string;
  /** orchestrator:speaking - how long the voice envelope plays (seconds). */
  duration?: number;
  /** agent:status(working) - the Claude model driving this agent (claude-opus-4-8,
   *  claude-sonnet-4-6, …). Tints the agent's chip + trail by model identity. */
  model?: string;
  /** journey:sprout - the milestone the sprout precedes on its branch (story-link rewiring);
   *  journey:handoff - the RECEIVING milestone the work flows to. */
  nextId?: string;
  /** journey:status - the milestone's new plan status (done/active/next/later).
   *  Kept as its own field (not `status`, which is the AgentStatus vocabulary). */
  journeyStatus?: "done" | "active" | "next" | "later";

  /**
   * SOURCE TAG (spec §A.1 - visual-truth mandate). `true` marks a DECORATIVE event
   * from the mock ambient timeline (mockTimeline.ts, emitted through the BrainRuntime
   * player). Real events - the Rust session/transcript/Hermes/FlowRunner bridge
   * (useRealEvents.ts / realEvents.ts) and user actions (brain-dump sprouts) - leave
   * this falsy. LITERAL-FACT consumers (the StateBar counts + EXECUTING state, the
   * Waveform executing ripple, the roster/feed reducer) gate on `!synthetic` so they
   * stay honest when nothing real is live; AMBIENT consumers (brain glow / pulses /
   * bead flow / sector heat) deliberately ignore it, keeping the idle brain alive.
   */
  synthetic?: boolean;
}

/** A timeline entry is just an event with its scheduled time `t`. */
export type TimelineEntry = PraxisEvent;
