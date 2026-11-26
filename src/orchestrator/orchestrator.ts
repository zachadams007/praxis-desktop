/**
 * orchestrator.ts - Phase-3 real orchestrator: the autonomous second-brain loop.
 *
 * `orchestrate(goal)` is the entry point for any "build X" intent:
 *   1. THINK - calls hermes_brain with a plan prompt → parses JSON steps
 *                (per-step tool AND model - the brain routes the fleet).
 *   2. EXECUTE - for each step, picks the right driver (claude/codex/cursor),
 *                emits PraxisEvents to animate the brain, invokes agent_delegate.
 *   2a. SUPERVISE - (per-delegation, the Forge/Vega/Quill loop) after a tool
 *                returns, the brain judges the RESULT against THAT task; if it
 *                fell short, the SAME tool is re-prompted with the original task
 *                + concrete feedback (bounded: ≤ 2 re-prompts), then the step is
 *                marked failed with the evaluation attached so plan-level VERIFY
 *                handles it. See supervision.ts. Skipped when Hermes is off.
 *   2b. LOOK - (hybrid/live only, never background) when the plan names a
 *                qaWindow, run a Lens visual-QA pass over that real window
 *                (screenshot → vision model → findings) - at most 2 passes per
 *                run (first + final iteration) so cost and focus-stealing stay
 *                bounded. Findings feed straight into VERIFY.
 *   3. VERIFY - feeds the goal + every step result (+ any Lens findings) BACK
 *                to the brain: is the goal genuinely done? If not, the brain
 *                returns corrective steps - visual bugs become fix delegations.
 *   4. ITERATE - plan → execute → verify → reprompt … until the brain says done,
 *                the iteration budget is hit (default 5, configurable via
 *                localStorage praxis.orchestrator.maxiters.v1 or the opts arg),
 *                or every tool fails in a pass.
 *   5. RECORD - appends the run to %LOCALAPPDATA%\Praxis\runs.jsonl via the
 *                Rust `ledger_log_run` command and emits a closing a.ledger
 *                thought (the seed of the Ledger agent).
 *
 * Designed to be DEFENSIVE in a plain browser (no Tauri runtime): every invoke()
 * is guarded; failures emit a single "orchestrator offline" thought and return a
 * stub so nothing crashes downstream.
 *
 * The Rust commands expected (registered in lib.rs):
 *   hermes_brain(goal, model?, provider?) -> string
 *   agent_delegate(tool, prompt, cwd?, model?) -> string
 *   ledger_log_run(entry) -> ()
 *
 * Agent ids emitted here MUST exist in data/graph.ts AGENTS - unknown ids are
 * silently dropped by the store and 3D runtime. Used: a.praxis (orchestrator),
 * a.hermes (brain engine), a.forge/a.vega/a.quill (drivers), a.atlas (visible
 * computer-use operator), a.lens (visual QA), a.ledger (run record).
 */

import type { ActionOrigin } from "@/shared/actionOrigin";
import { newMissionId, missionTitle, postMissionMsg, praxisSay, type MissionArtifact } from "./missionThread";
import { stepLabel } from "./missionText";
import { eventBus as sharedEventBus } from "@/data/eventBus";
import type { PraxisEvent } from "@/data/schema";
const eventBus = sharedEventBus;
function missionBus(target: Pick<PraxisEvent, "taskId" | "areaId">) {
  return { emitOrchestrator: (e: PraxisEvent) => sharedEventBus.emitOrchestrator({ ...target, ...e }) };
}
import type { QaFinding } from "@/qa/qaClient";
import { classifyToolFailure, DRIVERS, type DriverTool, type Driver } from "./drivers";
import {
  cursorPoolExhaustion,
  isAvailabilityOnlyStep,
  type CursorPoolSnapshot,
  currentExecMode,
  resolveToolOrNull,
  resolveUsableTool,
  liveAvailability,
  invalidateAvailability,
  staticAvailability,
  unroutableReason,
  routeTaskKind,
  isHermesEnabled,
  isComputerUseEnabled,
  isToolEnabled,
  isHalted,
  defaultModelFor,
  type AvailabilityProbe,
  type FleetAvailability,
  type PlanLimitRow,
} from "./policy";
import { splitBrainDump, type BrainDumpTask } from "./parse";
import {
  BRIEF_FILE,
  TEAM,
  TEAM_MODEL_GUIDE,
  defaultTeamPlan,
  deliverResult,
  deliverableGate,
  ensureTeamCoverage,
  formatBrief,
  formatMemoryForPrompt,
  isNewProjectGoal,
  isMinimalWebProofGoal,
  isWebDeliverable,
  manifestSummary,
  manifestChanged,
  isDeliveryOnlyStep,
  wantsFreshBuild,
  resumeTeamPlan,
  DONE_MARKER,
  memoryQuery,
  HEADLESS_QA_RULE,
  namedTeam,
  availableTeam,
  standInModel,
  parseDelivery,
  projectSlug,
  repoFolderFor,
  sanitizeStepModel,
  teamStepPrompt,
  wantsProfile,
  type DeliveryIntent,
  type DeliveryResult,
  type MemoryHit,
  type WorkspaceManifest,
} from "./buildChain";
import { selectedBrainWithGate, railShortLabel, type BrainRail } from "./brain";
import { registerMission, finishMission } from "./missionControl";
import { loadAutonomy, type AutonomyKey } from "@/shared/autonomy";
import {
  startOwnedOrchestration,
  nextBrainDumpRunId,
  recordBrainDumpRun,
  patchBrainDumpRun,
  listBrainDumpRuns,
  brainDumpRunSummary,
  type BrainDumpRunRecord,
} from "./ownedRuns";
import {
  SUPERVISION_MAX_REPROMPTS,
  evaluateDelegationPrompt,
  endedOnToolError,
  parseDelegationVerdict,
  superviseDelegation,
  type SupervisionCycle,
  type SupervisionOutcome,
  type DelegationVerdict,
} from "./supervision";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OrchStep {
  taskId?: string;
  areaId?: string;
  tool: DriverTool;
  prompt: string;
  cwd?: string;
  why: string;
  /** Per-step model routing (claude: "claude-opus-5-5" | "claude-sonnet-5-5"; codex: e.g. "gpt-6-astra"; cursor: e.g. "grok-4.7-high"). */
  model?: string;
  /** Optional task id - when present, emitTaskComplete uses the direct id path. */
  id?: string;
  /** Live mode: run this step where the owner can watch it (see Driver.run). */
  visible?: boolean;
  /** LIVE team only: use the named agent's fresh, owned desktop session. */
  ownedLive?: boolean;
  /** Explicit local artifacts this step owns. Never inferred from free-form prose. */
  expectedFiles?: string[];
  /** Internal corrective step: require the whole static-site gate before accepting. */
  finalDeliverableCheck?: boolean;
}

interface LiveSessionState {
  sessionKey: string;
  /** Set only after live_operate_step returned its registered completion. */
  submitted: boolean;
  /** A rejected UI call has an unknown submission outcome; never dispatch again. */
  uncertain: boolean;
}

/** A run-local key makes `(run, agent, folder)` ownership explicit to Rust. */
export function newLiveRunKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  const nonce = uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `praxis-live-run-${nonce}`;
}

/** Keep a key stable for one agent/folder pair without guessing any filenames. */
export function liveSessionKeyFor(runKey: string, tool: DriverTool, folder: string): string {
  return `${runKey}:${tool}:${encodeURIComponent(folder.trim().toLowerCase())}`;
}

/** Local artifact facts that can safely be asserted only when a plan supplied them. */
export function expectedFilesCheck(
  manifest: WorkspaceManifest | null,
  expectedFiles?: string[],
): DelegationVerdict | null {
  if (!manifest) return { sufficient: false, feedback: "Praxis could not read the workspace manifest; verify the owned artifacts on disk." };
  if (!expectedFiles?.length) return null;
  const files = new Map(manifest.files.map((f) => [f.rel.replace(/\\/g, "/").toLowerCase(), f.bytes]));
  const canonical = expectedFiles.map((rel) => rel.replace(/\\/g, "/").toLowerCase());
  const missing = canonical.filter((rel) => !files.has(rel));
  const empty = canonical.filter((rel) => files.has(rel) && !files.get(rel));
  if (missing.length || empty.length) {
    const detail = [
      missing.length ? `missing ${missing.join(", ")}` : "",
      empty.length ? `empty ${empty.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    return { sufficient: false, feedback: `Praxis file check failed: ${detail}. Create or complete those exact workspace artifacts.` };
  }
  return { sufficient: true, feedback: "" };
}

export interface OrchPlan {
  steps: OrchStep[];
  summary: string;
  /**
   * Optional visual-QA target: a window-title substring (e.g. "Praxis",
   * "Catalyzed"). Set by the brain when the goal builds/changes a VISIBLE app
   * UI on this machine; the loop then runs Lens QA passes over that window.
   */
  qaWindow?: string;
  /** What the brain decided on its own authority beyond the owner's literal words (posted in Mission). */
  decisions?: string[];
  /** Ideas it proposes but did not plan (posted in Mission for the owner). */
  ideas?: string[];
}

export interface OrchVerdict {
  done: boolean;
  reason: string;
  /** Corrective next steps when !done (same shape as plan steps). */
  steps: OrchStep[];
  summary: string;
  /** Decisions the brain took while judging (posted in Mission). */
  decisions?: string[];
  /** Sovereign only: improvement steps worth one more pass once the goal is already met. */
  improvements?: OrchStep[];
}

export type OrchStepResult = OrchStep & {
  output: string;
  ok: boolean;
  secs: number;
  /**
   * Per-delegation supervision trail (the Forge/Vega/Quill loop): one entry per
   * evaluate cycle. Empty when supervision didn't run (Hermes off / not in
   * Tauri / brain unavailable / Live-mode operator path). `reprompts` is the
   * number of corrective re-prompts this delegation actually took (0 when the
   * first result was accepted). Present only when supervision ran.
   */
  supervision?: SupervisionCycle[];
  reprompts?: number;
  /** The step failed because its tool errored (not a rejected result). */
  toolError?: boolean;
};

export interface OrchResult {
  missionId?: string;
  workspace?: string;
  artifacts?: MissionArtifact[];
  /** Every executed step across ALL iterations, in order. */
  steps: OrchStepResult[];
  summary: string;
  /** How many plan → execute → verify passes ran (1 = single pass). */
  iterations: number;
  /** Final verdict - true when the brain confirmed the goal is genuinely done. */
  done: boolean;
  /** Set when every agent was out and the mission was queued to start again at this time (ms). */
  deferredUntil?: number;
  
  title?: string | null;
  /** Praxis opened the finished preview itself. */
  previewOpened?: boolean;
  /** Agents benched for this run and who covered their share. */
  benched?: { tool: DriverTool; standIn?: DriverTool | null }[];
}

export interface OrchOptions {
  missionId?: string;
  /**
   * Classification - new project vs repo, named team, delivery, slug - reads THESE: a brief
   * naturally names Praxis as the actor ("Praxis must verify"), and on 2026-09-30 that made a
   * new personal site run in the Praxis repo. Planning still reads the goal.
   */
  intent?: string;
  /** How many times this mission already waited for capacity (missionDeferral.ts). */
  deferrals?: number;
  /** Caller already posted the owner's opening message. */
  missionOpened?: boolean;
  /** Iteration budget override. Clamp ceiling depends on `unattended` (see below). */
  maxIterations?: number;
  /**
   * True for an explicit "run everything overnight / go do everything" session -
   * raises the iteration-budget ceiling from 10 to 500 so a real unattended run
   * isn't secretly capped mid-work. Never set implicitly for a normal ask.
   */
  unattended?: boolean;
  /**
   * Cooperative cancellation for a long (esp. unattended) run. Checked at the top
   * of every plan→execute→verify iteration; when aborted the loop stops cleanly
   * after the CURRENT iteration's in-flight tool calls finish (same granularity as
   * the Live-mode operator's own computer_use_abort - polled between stages, not
   * mid-call) and returns with `done:false`. Wired from voice "stop"/"stand down"
   * for unattended runs - see src/orchestrator/unattended.ts.
   */
  signal?: AbortSignal;
  /** Voice/tool owner forwarded unchanged to every desktop actuator so a scoped
   *  interruption can target this exact run without touching a replacement. */
  ownerToken?: string;
  /** @internal The caller already registered this exact owner/promise before a
   *  dynamic import. Prevents double registration while preserving ownership. */
  ownerRunRegistered?: boolean;
  /**
   * NATIVE orchestration: route this build goal into the Rust FlowRunner
   * (flow_start "delegate") - Praxis spawns + watches + verifies + retries the
   * coding session(s) ITSELF, no in-webview brain loop babysitting it. The engine
   * enforces the trust (III+) and HALT gates before any lane. DEFAULT OFF for now:
   * the flag flip to default-ON is the owner's call after he's tested a native run.
   * When set, orchestrate() returns as soon as the flow is STARTED (with the
   * flowId in the summary) - the flow continues in the background and streams
   * `praxis://flow-progress`; it does not block this call to completion.
   *
   * `cwd` is the target repo for the delegate flow's build lane. When omitted the
   * flow's {cwd} token is left empty and the lane runs in Praxis's own cwd - pass
   * one for a real build.
   */
  native?: boolean;
  /**
   * Target working directory. Native flows pass it to the build lane; the
   * in-webview loop gives it to every step whose plan didn't pin its own cwd.
   * When omitted, inferred from the goal's repo words (parse.ts inferRepo) so a
   * "fix the flight deck count" runs in the Praxis checkout, not wherever the
   * app happened to start.
   */
  cwd?: string;
  /**
   * The rail a brain-dump task was routed to (policy.ts routeTaskKind). Used
   * for the direct fallback plan and as the first reroute choice when the
   * brain's own pick is dark - never overrides a usable requested rail.
   */
  preferredTool?: DriverTool;
  /** @internal Injectable live-availability probe (headless tests). */
  availabilityProbe?: AvailabilityProbe;
}

/** Resolve the model that may safely cross a driver boundary. A model pin is
 * valid only for the tool it was authored for; when policy reroutes the step,
 * use the destination rail's fleet default instead of forwarding an
 * incompatible alias such as Claude `opus` to Codex. */
export function modelForResolvedStep(
  step: Pick<OrchStep, "tool" | "model">,
  resolvedTool: DriverTool,
): string | undefined {
  return resolvedTool === step.tool
    ? step.model ?? defaultModelFor(resolvedTool)
    : defaultModelFor(resolvedTool);
}


export function nativeFlowRoute(
  preferred: DriverTool = "codex",
  avail?: FleetAvailability,
): { tool: DriverTool; model: string | undefined } | null {
  const tool = avail ? resolveUsableTool(preferred, avail).tool : resolveToolOrNull(preferred);
  return tool ? { tool, model: defaultModelFor(tool) } : null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function nowT(): number {
  return performance.now() / 1000;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** Dynamically import invoke so this module is safe to bundle for browser. */
async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

function emitThought(agentId: string, thought: string): void {
  eventBus.emitOrchestrator({ type: "agent:thinking", t: nowT(), agentId, thought });
}

// ── Iteration budget ──────────────────────────────────────────────────────────

const MAX_ITERS_KEY = "praxis.orchestrator.maxiters.v1";
const DEFAULT_MAX_ITERS = 5;
// A single interactive ask (voice/chat, no explicit override) never runs past 10
// iterations without the owner saying so - a quiet runaway loop on a normal request
// would be a bug, not a feature.
const INTERACTIVE_MAX_ITERS = 10;
const UNATTENDED_MAX_ITERS = 500;

/**
 * Iteration budget: opts override → localStorage → default 5.
 * Clamped 1–10 for ordinary interactive runs; 1–500 when `opts.unattended` is set
 * (an explicit "run everything overnight" session, not the default for a normal ask).
 */
export function iterationBudget(opts?: OrchOptions): number {
  const ceiling = opts?.unattended ? UNATTENDED_MAX_ITERS : INTERACTIVE_MAX_ITERS;
  const clamp = (n: number) => Math.min(ceiling, Math.max(1, Math.floor(n)));
  if (opts?.maxIterations && Number.isFinite(opts.maxIterations)) return clamp(opts.maxIterations);
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(MAX_ITERS_KEY);
      if (raw) {
        const n = parseInt(raw, 10);
        if (Number.isFinite(n)) return clamp(n);
      }
    }
  } catch {
    /* storage unavailable - default */
  }
  return opts?.unattended ? ceiling : DEFAULT_MAX_ITERS;
}

// ── Task cross-off ────────────────────────────────────────────────────────────

/**
 * Cross off the matching Command Center to-do when a goal completes.
 *
 * Match semantics (fixes the backwards-needle bug):
 *   markDoneByText checks `task.text.includes(needle)` - the TASK TEXT is the
 *   haystack. The goal is a long user utterance, so we must NOT pass the whole
 *   goal as the needle (it's bigger than any roadmap row).
 *
 *   Instead we use token-overlap: split both goal and each task.text into
 *   lowercase words and match if the task contributes ≥ 60 % of its own tokens
 *   to the goal. We pass the TASK TEXT as the needle so the store's own
 *   `task.text.includes(needle)` check does an exact self-match.
 *
 *   If a step carries an explicit task id, emit {id} for a direct markDone hit.
 */

/** Tokenize text the same way for both the goal and each task's text. */
function overlapTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Pure token-overlap scorer shared by emitTaskComplete's fuzzy path and the
 * test harness. Finds which task.text the goal most likely satisfies: the
 * fraction of the TASK's own tokens that also appear in the goal. Returns
 * null when no task clears the 60% overlap bar.
 */
export function bestTaskMatch(
  goal: string,
  tasks: { text: string }[],
): { text: string; score: number } | null {
  const goalTokens = new Set(overlapTokens(goal));

  let bestText: string | null = null;
  let bestScore = 0;

  for (const task of tasks) {
    const taskTokens = overlapTokens(task.text);
    if (taskTokens.length === 0) continue;
    const overlap = taskTokens.filter((tok) => goalTokens.has(tok)).length;
    const score = overlap / taskTokens.length;
    if (score > bestScore) {
      bestScore = score;
      bestText = task.text;
    }
  }

  if (bestText !== null && bestScore >= 0.6) {
    return { text: bestText, score: bestScore };
  }
  return null;
}

async function emitTaskComplete(goal: string, taskId?: string): Promise<void> {
  try {
    const { emit } = await import("@tauri-apps/api/event");

    // Fast path: exact id match beats fuzzy text every time.
    if (taskId) {
      await emit("praxis://task-complete", { id: taskId });
      return;
    }

    // Fuzzy path: score the goal against the items actually ON the to-do list
    // (hook-free read of the shared-origin localStorage) so every match is
    // crossable. The old corpus here - the frozen roadmapTasks() array - became
    // a permanent no-op once MANIFEST seeding moved to the live intent ledger
    // (2026-07-09): it matched task texts that never existed in the list.
    const { upcomingTaskTexts } = await import("@/command/todoStore");
    const match = bestTaskMatch(goal, upcomingTaskTexts());

    // Require at least 60 % token overlap to avoid false positives.
    if (match !== null) {
      // Pass the TASK TEXT as the needle - store does task.text.includes(needle)
      // which is a self-match when needle === task.text.
      await emit("praxis://task-complete", { text: match.text });
    }
  } catch {
    /* not in Tauri or emit unavailable - ignore */
  }
}

// ── Prompts ───────────────────────────────────────────────────────────────────


const TOOL_MENU = [
  "Tool menu - pick the best tool AND model per step. The fleet names Zach uses map to tools: Forge = claude, Vega = codex, Quill = cursor.",
  TEAM_MODEL_GUIDE,
  "Every rail runs on its subscription CLI and only when its breaker is enabled and the CLI is signed in; unavailable rails fall back through policy.",
].join("\n");

/** What Praxis already established before planning, so the plan is grounded. */
export interface PlanContext {
  /** Coding agents the goal NAMED - each MUST get at least one step. */
  team?: DriverTool[];
  /** Absolute build folder for a new project (every step runs there). */
  workspace?: string;
  /** Compact memory block (formatMemoryForPrompt). */
  memory?: string;
  /** Delivery Praxis performs itself after verification. */
  delivery?: DeliveryIntent | null;
  /** A new web build Praxis opens from disk - plan steps must not ask for a framework. */
  webDeliverable?: boolean;
  /** Manifest summary of an unfinished build in this workspace that the plan must CONTINUE. */
  existing?: string;
  /** How far the brain may go beyond the literal ask (authorityFor, from the trust dial). */
  authority?: string;
  
  capacity?: string;
}

// ── Authority: the owner's trust dial decides how far Praxis goes on its own ──────

/**
 * Every decision it takes is posted in Mission, so a choice made for him is never invisible.
 */
export function authorityFor(level: AutonomyKey): { text: string; sovereign: boolean } {
  if (level === "full") {
    return {
      sovereign: true,
      text: 'Authority — SOVEREIGN: Zach trusts you to own this outcome the way he would. Make the product decisions yourself: choose the approach, add features or ideas that clearly serve his goal, and change whatever would make the result better — within the spirit of the goal and the safety rules (never spend money, sign in, send messages or publish). List every decision you make beyond his literal words in "decisions" (one short line each).',
    };
  }
  if (level === "operator") {
    return {
      sovereign: false,
      text: 'Authority — EXECUTE: deliver what Zach asked at a high bar. Small improvements that clearly serve the goal are yours to make — list them in "decisions". Bigger ideas go in "ideas" for Zach instead of being built.',
    };
  }
  return {
    sovereign: false,
    text: 'Authority — CAUTIOUS: build exactly what Zach asked and add no scope. Put any idea in "ideas" for him to decide.',
  };
}


/**
 * Claude and Codex: the tighter of their 5-hour and weekly windows. Cursor has no 5-hour window,
 * so its monthly Cursor Models pool is paced against the month - spending it exactly as fast as
 * the month passes reads 0.5.
 */
export interface RailCapacity {
  headroom: number | null;
  note: string;
}
export type FleetCapacity = Record<DriverTool, RailCapacity>;
type UsageRows = Array<{ key: string; plan: PlanLimitRow[] }>;
const CURSOR_CYCLE_MS = 30 * 24 * 60 * 60 * 1000;

export function railCapacity(rows: UsageRows, now = Date.now()): FleetCapacity {
  const plan = (key: string) => rows.find((r) => r.key === key)?.plan ?? [];
  const windows = (key: string, name: string): RailCapacity => {
    const p = plan(key);
    if (p.some((x) => x.window === "refused")) return { headroom: 0, note: `${name}: The vendor is refusing Claude Code (unavailable)` };
    if (p.some((x) => x.window === "auth")) return { headroom: 0, note: `${name}: signed out (unavailable)` };
    const real = p.filter((x) => x.basis === "real" && x.limit > 0 && (x.window === "5h" || x.window === "weekly"));
    if (!real.length) return { headroom: null, note: `${name}: no live reading` };
    const pct = (w: string): number | null => {
      const r = real.find((x) => x.window === w);
      return r ? Math.min(100, (r.used / r.limit) * 100) : null;
    };
    const five = pct("5h");
    const week = pct("weekly");
    const used = Math.max(five ?? 0, week ?? 0);
    const parts = [five !== null ? `5h ${Math.round(five)}%` : "", week !== null ? `weekly ${Math.round(week)}%` : ""].filter(Boolean).join(", ");
    return { headroom: Math.max(0, 1 - used / 100), note: `${name}: ${parts} used` };
  };
  const cursor = (): RailCapacity => {
    const p = plan("cursor");
    const row = p.find((x) => /cursor models/i.test(x.label)) ?? p.find((x) => /total/i.test(x.label));
    if (!row || !(row.limit > 0)) return { headroom: null, note: "Cursor: no live reading" };
    const used = Math.min(1, Math.max(0, row.used / row.limit));
    const reset = row.resets_at ?? null;
    const elapsed = reset && reset > now ? Math.min(1, Math.max(0, 1 - (reset - now) / CURSOR_CYCLE_MS)) : 0.5;
    const pace = used / Math.max(elapsed, 0.1);
    return {
      headroom: Math.max(0, Math.min(1, 1 - pace / 2)),
      note: `Cursor: Cursor Models pool ${Math.round(used * 100)}% used, ${Math.round(elapsed * 100)}% through its month`,
    };
  };
  return { claude: windows("claude", "Claude"), codex: windows("codex", "Codex"), cursor: cursor() };
}

/** The capacity lines the planner reads. */
export function capacityBlock(cap: FleetCapacity): string {
  const line = (t: DriverTool) => {
    const h = cap[t].headroom;
    return `- ${cap[t].note}${h !== null ? ` (headroom ${Math.round(h * 100)}%)` : ""}`;
  };
  return [
    "Capacity right now — spread the work so no subscription runs dry while another sits idle; give more of the execution to the rail with the most headroom:",
    line("codex"),
    line("cursor"),
    line("claude"),
  ].join("\n");
}

/** Rails a step may move between. Never INTO Claude: its window also carries Praxis's own thinking. */
const PEER_RAILS: Record<DriverTool, DriverTool[]> = { codex: ["cursor"], cursor: ["codex"], claude: ["codex", "cursor"] };
/** Below this a rail is nearly spent. */
const LOW_HEADROOM = 0.2;
/** A move must land on a rail with at least this much more room. */
const MOVE_MARGIN = 0.3;

/**
 * Move a step off a nearly-spent rail onto the peer with real room - the code half of
 * keeping the windows even (the planner's capacity lines are the other half). A named
 * agent keeps at least one step: the owner asked for it.
 */
export function rebalanceSteps(
  steps: OrchStep[],
  cap: FleetCapacity,
  usable: (t: DriverTool) => boolean,
  team: DriverTool[] = [],
): { steps: OrchStep[]; moves: string[] } {
  const out = steps.map((s) => ({ ...s }));
  const moves: string[] = [];
  const count = (t: DriverTool) => out.filter((s) => s.tool === t).length;
  for (const s of out) {
    if (s.ownedLive) continue;
    const here = cap[s.tool]?.headroom;
    if (here === null || here === undefined || here >= LOW_HEADROOM) continue;
    if (team.includes(s.tool) && count(s.tool) <= 1) continue;
    const best = PEER_RAILS[s.tool]
      .filter((t) => usable(t) && (cap[t].headroom ?? 0) >= here + MOVE_MARGIN)
      .sort((a, b) => (cap[b].headroom ?? 0) - (cap[a].headroom ?? 0))[0];
    if (!best) continue;
    moves.push(`${TEAM[s.tool].name} → ${TEAM[best].name} (${cap[s.tool].note})`);
    s.tool = best;
    s.model = standInModel(best);
  }
  return { steps: out, moves };
}


export function balanceBrain<B extends { provider: string; model: string; fallbacks?: BrainRail[] }>(
  brain: B,
  cap: FleetCapacity,
): { brain: B; note?: string } {
  const own: DriverTool | null = brain.provider === "claude-max" ? "claude" : brain.provider === "openai-codex" ? "codex" : null;
  if (!own) return { brain };
  const other: DriverTool = own === "claude" ? "codex" : "claude";
  const mine = cap[own].headroom;
  const theirs = cap[other].headroom;
  if (mine === null || theirs === null || mine >= 0.15 || theirs < 0.35) return { brain };
  const otherProvider = other === "claude" ? "claude-max" : "openai-codex";
  const next = (brain.fallbacks ?? []).find((r) => r.provider === otherProvider);
  if (!next) return { brain };
  const rest = [{ provider: brain.provider, model: brain.model }, ...(brain.fallbacks ?? []).filter((r) => r !== next)];
  return {
    brain: { ...brain, provider: next.provider, model: next.model, fallbacks: rest },
    note: `Praxis is thinking on ${railShortLabel(next)} this run — ${cap[own].note}`,
  };
}

// ── Looking at it: Praxis checks the finished page with its own eyes ─────────


export function lookPrompt(goal: string): string {
  return [
    "You are Praxis, Zach's AI orchestrator. Your agents just built this for him; LOOK at it the way he would before calling it done.",
    `His goal: ${goal.slice(0, 600)}`,
    "The attached images are full-page screenshots of the result at phone (390px), tablet (768px) and desktop (1440px) widths.",
    "Judge it like a demanding product designer: does it look finished, polished and right for the goal? Name only problems you can actually SEE (layout, spacing, overlap, cut-off or unreadable text, broken images, unstyled or placeholder content, things the goal asked for that are missing).",
    "Do not run commands or edit files. Return ONLY valid JSON (no prose, no markdown fences):",
    '{"ok":true|false,"verdict":"one line ≤ 140 chars","issues":["one concrete visible problem per entry, at most 5"]}',
  ].join("\n");
}

export function parseLook(raw: string): { ok: boolean; verdict: string; issues: string[] } | null {
  try {
    const obj = JSON.parse(stripFences(raw)) as { ok?: unknown; verdict?: unknown; issues?: unknown };
    if (typeof obj.ok !== "boolean") return null;
    const issues = Array.isArray(obj.issues)
      ? obj.issues.filter((i): i is string => typeof i === "string" && i.trim() !== "").map((i) => i.trim().slice(0, 200)).slice(0, 5)
      : [];
    return { ok: obj.ok && issues.length === 0, verdict: typeof obj.verdict === "string" ? obj.verdict.trim().slice(0, 160) : "", issues };
  } catch {
    return null;
  }
}


async function lookAtBuild(goal: string, screenshots: string[]): Promise<{ ok: boolean; verdict: string; issues: string[] } | null> {
  if (!screenshots.length) return null;
  try {
    const { getFleetSelection } = await import("@/command/fleetStore");
    const pick = getFleetSelection("lens");
    const model = pick?.billing === "chatgpt" ? pick.id : "gpt-6-astra";
    const raw = await tauriInvoke<string>("praxis_look", { prompt: lookPrompt(goal), images: screenshots.slice(0, 3), model });
    return parseLook(raw);
  } catch {
    return null;
  }
}

/** A model's sentence without its own closing punctuation, so a template can add one ("insufficient.. Sent" read live 2026-10-10). */
function sentence(text: string | undefined): string {
  return (text ?? "").trim().replace(/[.!;:,\s]+$/, "");
}

function stringList(x: unknown, max = 5): string[] {
  return Array.isArray(x)
    ? x.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim().slice(0, 220)).slice(0, max)
    : [];
}

/** Build the "think" prompt. Asks the brain for a strict JSON plan. */
export function planPrompt(goal: string, ctx: PlanContext = {}): string {
  const team = ctx.team ?? [];
  return [
    "You are the Praxis orchestrator brain. Given a goal, return ONLY valid JSON (no prose, no markdown fences) in this exact shape:",
    '{"steps":[{"tool":"codex|claude|cursor","model":"optional tool-compatible model","prompt":"...","cwd":"optional/path","expectedFiles":["exact/relative/file.ext"],"why":"one-line reason"}],"summary":"...","qaWindow":"optional window-title substring","decisions":["optional"],"ideas":["optional"]}',
    TOOL_MENU,
    ...(ctx.capacity ? [ctx.capacity] : []),
    ...(ctx.authority ? [ctx.authority] : []),
    "Write each step prompt the way a strong engineering lead briefs a capable engineer: the outcome, the files involved, the constraints, and how the agent should check its own work before reporting.",
    "Never plan steps that only check, record or wait on another agent's availability. Praxis reroutes unavailable rails itself; plan only work on the deliverable.",
    "Praxis ITSELF announces the result in Mission, files it in Zach's Inbox and opens it when asked - after the work is done. Those are never agent work: never plan or require steps that report to Mission, the Inbox or Zach, and never judge the goal unfinished because they haven't happened yet.",
    `Rules: tool MUST be codex, claude, or cursor. model, cwd and expectedFiles are optional. Use expectedFiles only for exact workspace-relative artifacts the step itself must create or change; never infer filenames from prose, use globs, or name files another step owns. ${ctx.existing ? "0–5 steps (an empty list when nothing is left to do)" : "1–5 steps max"}. summary ≤ 120 chars. Disabled or unavailable rails fall back through policy; never rewrite an enabled requested rail.`,
    ...(team.length
      ? [
          ctx.existing
            ? `Zach NAMED the team for this goal: ${team.map((t) => `${TEAM[t].name} (${t})`).join(", ")}. They already built what is on disk in earlier runs. Give a step ONLY to an agent with real remaining work on those files, and return "steps": [] when the files already meet the goal and the quality bar — Praxis then verifies them and delivers.`
            : `Zach NAMED the team for this goal: ${team.map((t) => `${TEAM[t].name} (${t})`).join(", ")}. Each available member gets a real share of the work. Benched agents are covered by their stand-ins; that share counts as done, in a sensible order where each builds on files the previous one wrote.`,
        ]
      : []),
    ...(ctx.workspace
      ? [
          `This is a NEW project. Its workspace is ${ctx.workspace} and ${BRIEF_FILE} there already holds the goal, the quality bar and the memory below. Omit cwd (every step runs in the workspace). Each step prompt should name the concrete files that agent creates or improves.`,
        ]
      : []),
    ...(ctx.existing
      ? [
          `This workspace ALREADY holds an unfinished build from an earlier run — CONTINUE it, do not start over: review what is there, fix what is wrong, finish what is missing, keep what is good. On disk now: ${ctx.existing}`,
        ]
      : []),
    ...(ctx.webDeliverable
      ? [
          "The deliverable is a STATIC site opened straight from disk: index.html + styles.css + script.js at the workspace root. No step may ask for a framework (React, Vue, Svelte, Next, Vite…), a bundler, npm install or a build step — a framework shell renders blank from file://.",
        ]
      : []),
    ...(ctx.delivery?.open
      ? [
          `Praxis itself opens the finished result in the browser${ctx.delivery.maximize ? " and maximizes it" : ""} after verifying the files — no step may open a browser or window.`,
        ]
      : [
          "If the goal builds or changes a VISIBLE app UI on this machine, set qaWindow to that app's window-title substring (e.g. 'Praxis', 'Catalyzed') so a vision QA pass can inspect the result; omit it otherwise.",
        ]),
    ...(ctx.memory ? ["", ctx.memory] : []),
    "",
    `Goal: ${goal}`,
  ].join("\n");
}

/**
 * Build the "verify" prompt - the reflect/decide phase of the loop. The brain
 * sees the goal plus what every step actually returned and must judge whether
 * the goal is GENUINELY done; if not, it produces the corrective next steps.
 *
 * `qaContext` (when a Lens visual-QA pass ran this iteration) is the compact
 * findings block from formatQaBlock() - the brain's corrective steps then
 * naturally address the visual bugs, which IS the fix-delegation loop.
 */
export function verifyPrompt(
  goal: string,
  executed: OrchStepResult[],
  qaContext?: string,
  groundTruth?: string,
  delivery?: DeliveryIntent | null,
  benched: { tool: DriverTool; standIn?: DriverTool | null }[] = [],
  extra: { authority?: string; improvementsAllowed?: boolean } = {},
): string {
  // Cap the transcript so the verify call stays cheap: last 12 steps, outputs
  // truncated - enough signal to judge, not a full log dump.
  const lines = executed.slice(-12).map((s, i) => {
    const head = `${i + 1}. [${s.tool}${s.model ? `/${s.model}` : ""}] ${s.ok ? "ok" : "FAILED"} — ${s.prompt.slice(0, 160)}`;
    const out = (s.output || "(no output)").slice(0, 700);
    return `${head}\n   output: ${out}`;
  });
  return [
    "You are the Praxis orchestrator brain, verifying your own delegated work.",
    `Goal: ${goal}`,
    "",
    "Executed steps and what each returned:",
    ...(lines.length ? lines : ["(no agent ran — the planner judged the files on disk complete; judge them by the ground truth below)"]),
    ...(qaContext ? ["", qaContext] : []),
    ...(groundTruth
      ? [
          "",
          "GROUND TRUTH — Praxis read the workspace itself. Trust this over anything a step claimed:",
          groundTruth,
        ]
      : []),
    "",
    "Decide: is the goal GENUINELY done (not just attempted)? Return ONLY valid JSON (no prose, no markdown fences) in this exact shape:",
    '{"done":true|false,"reason":"one line ≤ 120 chars","steps":[{"tool":"codex|claude|cursor","model":"optional tool-compatible model","prompt":"...","cwd":"optional/path","why":"one-line reason"}],"summary":"...","decisions":["optional"]' + (extra.improvementsAllowed ? ',"improvements":[same shape as steps]' : "") + "}",
    'If done, "steps" MUST be []. If NOT done, "steps" MUST contain 1–5 corrective next steps (fix failures, fill the gaps — do NOT repeat steps that already succeeded).',
    "Judge like Zach would: correct, complete and good — not just present. Praxis's own look at the screenshots, when included in the ground truth, counts as evidence.",
    ...(extra.authority ? [extra.authority] : []),
    ...(extra.improvementsAllowed
      ? ['Sovereign: when the goal IS met but a clearly valuable improvement remains that Zach would want, return done:true and put at most 2 improvement steps in "improvements" (Praxis runs them once). Otherwise omit "improvements".']
      : []),
    // Live 2026-10-01: the goal was Atlas's brief ("Cursor (Quill) for integration", "Praxis
    // announces the result in Mission"), Quill was benched for usage, and the verifier kept
    // adding "fill missing Quill participation and Mission handoff" steps for Forge.
    "Praxis ITSELF announces the result in Mission, files it in Zach's Inbox and opens it when asked - after the work is done. Those are never agent work: never plan or require steps that report to Mission, the Inbox or Zach, and never judge the goal unfinished because they haven't happened yet.",
    ...(benched.length
      ? [
          `Benched for this run (out of usage or switched off): ${benched.map((b) => `${TEAM[b.tool].name}${b.standIn ? ` - ${TEAM[b.standIn].name} covered its share` : ""}`).join("; ")}. A benched agent's share counts as done when its stand-in did that work: never return done:false because a benched agent did not take part, and never create a step to add its participation.`,
        ]
      : []),
    // Live 2026-09-16 (run 4): the verifier judged the site "not done" because it
    // had not been opened and maximized yet, and sent Quill to open a browser. Praxis
    // only delivers AFTER done:true, so that verdict could never change - a loop of
    // corrective passes that never ends in delivery.
    ...(delivery?.open
      ? [
          `Opening the result in a browser${delivery.maximize ? " and maximizing the window" : ""} is done by Praxis ITSELF immediately after you return done:true. It is NOT unfinished work: judge only the files and the build. Never return done:false because the result has not been opened, and never create a step that opens a browser, starts a server or touches a window.`,
        ]
      : []),
    ...(qaContext
      ? [
          "Unfixed high/med visual QA findings mean the goal is NOT genuinely done — corrective steps must address them.",
        ]
      : []),
    TOOL_MENU,
  ].join("\n");
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/** Strip ```json … ``` fences. */
function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/** Parse an unknown value into validated OrchSteps (shared by plan + verdict). */
function expectedFilesFrom(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  // Exact workspace-relative names only. This contract deliberately rejects
  // traversal, absolute paths and vague glob patterns so a planner cannot turn
  // ordinary prose into a speculative local-file assertion.
  const files = raw
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim().replace(/\\/g, "/"))
    .filter((v) => /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/.test(v));
  return files.length ? [...new Set(files)].slice(0, 12) : undefined;
}

function parseSteps(raw: unknown): OrchStep[] {
  if (!Array.isArray(raw)) return [];
  const VALID_TOOLS: DriverTool[] = ["claude", "codex", "cursor"];
  return raw
    .filter(
      (s): s is { tool: DriverTool; prompt: string; cwd?: unknown; why?: unknown; model?: unknown; expectedFiles?: unknown } =>
        typeof s === "object" &&
        s !== null &&
        VALID_TOOLS.includes((s as { tool?: unknown }).tool as DriverTool) &&
        typeof (s as { prompt?: unknown }).prompt === "string",
    )
    .map((s) => ({
      tool: s.tool,
      prompt: s.prompt,
      cwd: typeof s.cwd === "string" ? s.cwd : undefined,
      why: typeof s.why === "string" ? s.why : "",
      model:
        typeof s.model === "string" && s.model.trim()
          ? s.model.trim()
          : undefined,
      expectedFiles: expectedFilesFrom(s.expectedFiles),
    }));
}

/** Parse the plan JSON. Returns null on any error. */
export function parsePlan(raw: string, opts?: { allowEmpty?: boolean }): OrchPlan | null {
  try {
    const obj = JSON.parse(stripFences(raw)) as unknown;
    if (
      typeof obj !== "object" ||
      obj === null ||
      !Array.isArray((obj as { steps?: unknown }).steps)
    ) {
      return null;
    }
    const plan = obj as { steps: unknown[]; summary?: unknown; qaWindow?: unknown; decisions?: unknown; ideas?: unknown };
    const steps = parseSteps(plan.steps);
    const rawSummary = typeof plan.summary === "string" ? plan.summary : "";
    const qaWindow =
      typeof plan.qaWindow === "string" && plan.qaWindow.trim() ? plan.qaWindow.trim() : undefined;
    // A resumed build the planner judges complete answers "steps": [] on purpose;
    // anywhere else an empty list is a malformed plan and runs the goal directly.
    const emptyOnPurpose = opts?.allowEmpty === true && plan.steps.length === 0;
    return {
      steps: steps.length || emptyOnPurpose ? steps : [{ tool: "codex", prompt: rawSummary || "execute goal", why: "fallback" }],
      summary: rawSummary,
      qaWindow,
      decisions: stringList(plan.decisions),
      ideas: stringList(plan.ideas),
    };
  } catch {
    return null;
  }
}

/**
 * Build the lightweight drift-check prompt. Used every DRIFT_CHECK_EVERY steps
 * in unattended runs to catch scope creep, tool thrashing, or wrong-area work
 * before it compounds. Advisory: does not change loop flow; the next VERIFY
 * re-anchors if drift is confirmed.
 */
function driftPrompt(goal: string, completed: OrchStepResult[]): string {
  const recent = completed.slice(-DRIFT_CHECK_EVERY).map((s, i) =>
    `${i + 1}. [${s.tool}] ${s.ok ? "ok" : "FAILED"} — ${s.prompt.slice(0, 100)}`,
  );
  return [
    "You are the Praxis orchestrator doing a quick drift check on a long-running unattended session.",
    `Original goal: ${goal}`,
    "",
    "Most recent steps:",
    ...recent,
    `(${completed.length} total steps completed so far)`,
    "",
    'Return ONLY valid JSON: {"aligned":true|false,"reason":"one line ≤ 100 chars"}',
    "aligned=true means work clearly advances the original goal. aligned=false means it has drifted (wrong area, tool thrashing, unrelated fixes, or scope creep).",
  ].join("\n");
}

/** Parse the verify JSON. Returns null when the reply isn't a usable verdict. */
export function parseVerdict(raw: string): OrchVerdict | null {
  try {
    const obj = JSON.parse(stripFences(raw)) as unknown;
    if (typeof obj !== "object" || obj === null) return null;
    const v = obj as { done?: unknown; reason?: unknown; steps?: unknown; summary?: unknown; decisions?: unknown; improvements?: unknown };
    if (typeof v.done !== "boolean") return null;
    return {
      done: v.done,
      reason: typeof v.reason === "string" ? v.reason : "",
      steps: parseSteps(v.steps),
      summary: typeof v.summary === "string" ? v.summary : "",
      decisions: stringList(v.decisions),
      improvements: parseSteps(v.improvements).slice(0, 2),
    };
  } catch {
    return null;
  }
}

/** Fallback plan when the brain call fails or returns unparseable output. */
function fallbackPlan(goal: string, tool: DriverTool = "codex"): OrchPlan {
  return {
    steps: [{ tool, prompt: goal, why: "direct execution (plan unavailable)" }],
    summary: goal.slice(0, 120),
  };
}

/** Marker prefix on a skipped step's output - the summary and tests key off it. */
const UNROUTABLE = "unroutable: ";

// ── Visual QA (the Lens agent's LOOK step) ───────────────────────────────────

/**
 * Hard cap on Lens QA passes per orchestrate() run.
 */
const QA_MAX_PASSES = 2;

/** Unattended runs check for goal drift every N cumulative steps. */
const DRIFT_CHECK_EVERY = 5;

/** Compact Lens summary recorded in the run ledger's additive `qa` field. */
interface QaRunSummary {
  window: string;
  /** QA passes ATTEMPTED (a failed/unavailable pass still consumed a slot). */
  passes: number;
  findings: number;
  high: number;
  med: number;
  low: number;
}

/** Tally findings by severity. */
function severityCounts(findings: QaFinding[]): { high: number; med: number; low: number } {
  const c = { high: 0, med: 0, low: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

/**
 * Format the findings block appended to the verify prompt. Kept to one line so
 * the verify call stays cheap: severities sorted worst-first, capped at 12
 * findings, issues truncated.
 */
function formatQaBlock(windowTitle: string, findings: QaFinding[]): string {
  if (findings.length === 0) {
    return `Visual QA (Lens) findings on '${windowTitle}': no visual defects found.`;
  }
  const order = { high: 0, med: 1, low: 2 } as const;
  const parts = [...findings]
    .sort((a, b) => order[a.severity] - order[b.severity])
    .slice(0, 12)
    .map((f) => `[${f.severity}] ${f.element} — ${f.issue.slice(0, 140)}`);
  return `Visual QA (Lens) findings on '${windowTitle}': ${parts.join("; ")}`;
}

/**
 * Run one guarded Lens QA pass over the window whose title contains
 * `windowTitle`. Dynamic-imports the qa client (same pattern tauriInvoke uses
 * for @tauri-apps/api) so browser bundles stay safe.
 *
 * Returns the findings array, or null when QA is UNAVAILABLE (import/invoke
 * failure) - null never fails the run; the verify prompt simply gets no visual
 * context this pass. qa_eyes.rs already emits one a.lens event per finding, so
 * this only adds the bracketing "inspecting…" / "N findings" thoughts.
 */
async function runQaPassGuarded(windowTitle: string): Promise<QaFinding[] | null> {
  emitThought("a.lens", `Lens inspecting ${windowTitle}…`);
  try {
    const { runQaPass } = await import("@/qa/qaClient");
    const { getFleetSelection } = await import("@/command/fleetStore");
    // Fleet panel's Lens model (Command Center), gated to ids qa_eyes.rs can run
    // (OpenRouter/NVIDIA). A ChatGPT pick is for praxis_look (lookAtBuild), not this
    // seam. Falls through to qa_eyes.rs's QA_VISION_MODEL otherwise.
    const pick = getFleetSelection("lens");
    const model = pick && (pick.billing === "openrouter" || pick.billing === "nvidia") ? pick.id : undefined;
    const findings = await runQaPass(windowTitle, model);
    const { high } = severityCounts(findings);
    emitThought("a.lens", `Lens: ${findings.length} findings (${high} high)`);
    return findings;
  } catch {
    emitThought("a.lens", "Lens unavailable — visual QA skipped this pass");
    return null;
  }
}

// ── Run ledger (the Ledger agent's seed) ─────────────────────────────────────

/**
 * Persist the finished run to %LOCALAPPDATA%\Praxis\runs.jsonl via the Rust
 * `ledger_log_run` command, then emit a closing a.ledger thought. Best-effort:
 * a missing command / dev browser never fails the orchestration result.
 *
 * `qa` (optional, additive) records the Lens visual-QA summary for the run -
 * mirrored by the schema-loose `qa: Option<serde_json::Value>` field on the
 * Rust RunEntry, so the frontend owns this shape.
 */
async function recordRun(
  goal: string,
  steps: OrchStepResult[],
  iterations: number,
  done: boolean,
  totalSecs: number,
  qa?: QaRunSummary,
  build?: Record<string, unknown>,
): Promise<void> {
  const okCount = steps.filter((s) => s.ok).length;
  try {
    await tauriInvoke("ledger_log_run", {
      entry: {
        ts: Date.now(),
        goal,
        iterations,
        steps: steps.map((s) => ({
          tool: s.tool,
          model: s.model ?? null,
          ok: s.ok,
          summary: (s.output || s.prompt).slice(0, 200),
          secs: Math.round(s.secs * 10) / 10,
          // ── Supervision trail (additive, backward-compatible) ──────────────
          // Number of corrective re-prompts this delegation took (0 = accepted
          // on the first result), plus the per-cycle verdicts (verdict + the
          // feedback that drove each re-prompt) so runs are auditable: you can
          // see WHY a step was re-prompted and whether it recovered or failed.
          // Emitted only when supervision actually ran (fields absent otherwise
          // → old ledger readers are unaffected).
          ...(s.reprompts !== undefined ? { reprompts: s.reprompts } : {}),
          ...(s.supervision && s.supervision.length
            ? {
                supervision: s.supervision.map((c) => ({
                  attempt: c.attempt,
                  sufficient: c.sufficient,
                  ...(c.feedback ? { feedback: c.feedback.slice(0, 200) } : {}),
                })),
              }
            : {}),
        })),
        done,
        total_secs: Math.round(totalSecs * 10) / 10,
        ...(qa ? { qa } : {}),
        // Team / workspace / memory sources / file gate / delivery - schema-loose
        // like `qa`, so the run shows exactly which memory notes it used.
        ...(build ? { build } : {}),
      },
    });
    emitThought(
      "a.ledger",
      `run logged: ${steps.length} step${steps.length === 1 ? "" : "s"}, ${okCount} ok, ${iterations} iteration${iterations === 1 ? "" : "s"} — goal ${done ? "done" : "incomplete"}`,
    );
  } catch {
    /* ledger unavailable (dev browser / command missing) - non-fatal */
  }

  // Best-effort + fully independent of the ledger write above (its own try/catch) so a missing
  // command never affects the orchestration result.
  try {
    await tauriInvoke("write_run_note", {
      entry: {
        goal,
        steps: steps.map((s) => ({ tool: s.tool, model: s.model ?? null, ok: s.ok })),
        models: [...new Set(steps.map((s) => s.model).filter((m): m is string => Boolean(m)))],
        done,
        ts: Date.now(),
      },
    });
  } catch {
    /* vault write unavailable (dev browser / command missing) - non-fatal */
  }

  // Hermes self-improvement hook (2026-07-02): feed genuinely durable lessons - NOT every
  // run - into Hermes's real built-in memory (`~/.hermes/memories/MEMORY.md`, via the
  // `hermes_teach` command → `hermes -z` → the agent's own `memory` tool). Only runs with
  // something worth learning qualify: a step that needed supervision correction (the brain
  // had to re-prompt with feedback) or a step that failed outright. A clean run with zero
  // corrections has nothing new to teach and would just burn MEMORY.md's tight 2,200-char
  // budget on noise. Best-effort + fully independent of the writes above.
  // NOT awaited: `hermes -z` takes ~50 s, and live 2026-09-17 awaiting it held the
  // finished run's result - the owner's site was open and maximized a full minute before
  // Atlas said it was done.
  void teachHermesFromRun(goal, steps, done);
}

/** Build a compact lesson from one run's supervision/failure trail and feed it to Hermes's
 *  built-in memory, if there's anything worth teaching. No-op (no Hermes call) for a clean run. */
async function teachHermesFromRun(goal: string, steps: OrchStepResult[], done: boolean): Promise<void> {
  const lessons: string[] = [];

  for (const s of steps) {
    if (s.supervision && s.supervision.length) {
      const feedbacks = s.supervision
        .filter((c) => !c.sufficient && c.feedback)
        .map((c) => c.feedback.slice(0, 160));
      if (feedbacks.length) {
        lessons.push(
          `Delegating to ${s.tool}${s.model ? ` (${s.model})` : ""} for "${goal.slice(0, 100)}" needed correction: ${feedbacks[0]}`,
        );
      }
    } else if (!s.ok) {
      lessons.push(
        `Delegating to ${s.tool}${s.model ? ` (${s.model})` : ""} failed for "${goal.slice(0, 100)}" — consider a different tool/approach next time.`,
      );
    }
  }

  if (!lessons.length) return; // clean run - nothing new to teach

  const lesson = `${lessons.slice(0, 2).join(" ")}${!done ? " (run did not complete.)" : ""}`.slice(0, 500);

  try {
    await tauriInvoke("hermes_teach", { lesson, target: "memory" });
  } catch {
    /* Hermes off/unavailable/slow - never blocks the orchestration result */
  }
}

// ── Per-delegation supervision (the Forge/Vega/Quill loop) ────────────────────

/**
 * Ask the brain to judge ONE delegated result against its task. Guarded like
 * every other brain call: returns null when Hermes is off, the brain is
 * unavailable, or we're not in Tauri - the caller then FAILS OPEN (accepts the
 * result as sufficient), since plan-level verify remains the backstop and we
 * never want a cheap evaluator hiccup to block a genuinely good result.
 *
 * `brain` is threaded in (not re-read) so a single orchestrate() run uses one
 * consistent brain selection across plan, verify, AND supervision.
 */
async function evaluateDelegation(
  task: string,
  output: string,
  brain: { model: string; provider: string; fallbacks?: BrainRail[] },
  signal?: AbortSignal,
): Promise<DelegationVerdict | null> {
  if (signal?.aborted) return null;
  try {
    const raw = await tauriInvoke<string>("hermes_brain", {
      goal: evaluateDelegationPrompt(task, output),
      model: brain.model,
      provider: brain.provider,
      fallbacks: brain.fallbacks,
    });
    return parseDelegationVerdict(raw);
  } catch {
    return null;
  }
}

/**
 * Run ONE delegation under supervision: execute the tool, evaluate the result
 * against the task, and - if the brain judges it insufficient - re-prompt the
 * SAME tool with the original task plus concrete feedback, up to
 * SUPERVISION_MAX_REPROMPTS times. This is Forge/Vega/Quill "monitoring and
 * making sure the task gets done": reason → do → evaluate → feedback → loop.
 *
 * The bounded loop logic lives in the pure `superviseDelegation()` (unit-tested
 * with mocks); this wrapper injects the REAL driver + brain seam and maps each
 * lifecycle beat to PraxisEvents so the fleet stays visible: every (re-)attempt
 * re-emits the driver's agent identity as WORKING with the task label + re-prompt
 * count (task:start label + a.<driver> thinking line), so a supervised re-prompt
 * is never invisible to the app - the roster shows Forge/Vega/Quill busy with
 * "(re-prompt N/2)" the whole time.
 *
 * Supervision is SKIPPED (single pass, historical behavior) when `supervise` is
 * false - i.e. Hermes planning is off (no brain to judge with).
 */
async function runSupervisedDelegation(
  driver: Driver,
  toolLabel: DriverTool,
  step: OrchStep,
  supervise: boolean,
  brain: { model: string; provider: string; fallbacks?: BrainRail[] },
  signal?: AbortSignal,
  groundTruth?: () => Promise<string>,
  localCheck?: () => Promise<DelegationVerdict | null>,
  liveSession?: LiveSessionState,
  missionId?: string,
): Promise<SupervisionOutcome & { review?: { verdict: "accepted" | "stuck"; text: string } }> {
  const eventBus = missionBus(step);
  const emitThought = (agentId: string, thought: string) => eventBus.emitOrchestrator({ type: "agent:thinking", t: nowT(), agentId, thought });
  // Praxis's supervision, said where the owner reads it (it used to live only in brain thoughts).
  // A send-back posts at once, while the agent reworks; the final word waits for the
  // agent's own report so the thread reads in order: reported → reviewed.
  const agentKey = TEAM[toolLabel].agentId.slice(2) as "forge" | "vega" | "quill";
  const name = TEAM[toolLabel].name;
  let review: { verdict: "accepted" | "stuck"; text: string } | undefined;
  const outcome = await superviseDelegation(step.prompt, supervise, {
    signal,
    runTool: async (prompt) => {
      if (signal?.aborted) throw new Error("Stopped by owner before tool admission.");
      // A supervised re-prompt is a new agent run - the breaker gates it too.
      if (isHalted()) throw new Error("HALT ALL is thrown — no new agent run admitted.");
      if (!isToolEnabled(toolLabel)) throw new Error(`${toolLabel} breaker is switched off`);
      if (step.ownedLive && liveSession?.uncertain) {
        throw new Error("LIVE retry refused: the prior owned-session submission outcome is unknown; refusing a duplicate dispatch.");
      }
      try {
        const out = await driver.run(`${prompt}\n\n${HEADLESS_QA_RULE}`, step.cwd, step.model, signal,
          step.ownedLive
            ? { visible: true, ownedLive: true, followUp: liveSession?.submitted === true, sessionKey: liveSession?.sessionKey, taskId: step.taskId, areaId: step.areaId }
            : { visible: step.visible, taskId: step.taskId, areaId: step.areaId });
        // A successful response is the frontend's only proof that Rust registered
        // the submitted owned chat. Every supervisor and plan retry may now follow up.
        if (step.ownedLive && liveSession) liveSession.submitted = true;
        // The supervisor judges what is ON DISK, not only what the agent says it
        // did: a new-project run appends Praxis's own file check to the output.
        if (!groundTruth) return out;
        const truth = await groundTruth().catch(() => "");
        return truth ? `${truth}\n\n${out}` : out;
      } catch (err) {
        // A rejected UI call may have crossed Enter without returning a registered
        // completion. Fail closed rather than start another chat and double-dispatch.
        if (step.ownedLive && liveSession) liveSession.uncertain = true;
        throw err;
      }
    },
    checkResult: async () => localCheck ? await localCheck() : null,
    evaluate: (task, output) => evaluateDelegation(task, output, brain, signal),
    onEvent: (ev) => {
      switch (ev.kind) {
        case "reprompt":
          if (missionId) {
            void praxisSay(missionId, "review", `Not there yet — ${sentence(ev.feedback) || "the result fell short of the task"}. Sent it back to ${name} (try ${ev.attempt + 1} of ${SUPERVISION_MAX_REPROMPTS + 1}).`, { agent: agentKey, verdict: "revise" });
          }
          // Re-emit the driver's identity as working with the re-prompt count -
          // the roster surfaces Forge/Vega/Quill busy on "(re-prompt N/2)".
          eventBus.emitOrchestrator({
            type: "task:start",
            t: nowT(),
            agentId: driver.id, taskId: step.taskId, areaId: step.areaId,
            label: `${toolLabel} (re-prompt ${ev.attempt}/${SUPERVISION_MAX_REPROMPTS}): ${step.prompt.slice(0, 40)}`,
          });
          emitThought(
            driver.id,
            `↻ re-prompt ${ev.attempt}/${SUPERVISION_MAX_REPROMPTS}: ${ev.feedback.slice(0, 60) || "insufficient result"}`,
          );
          break;
        case "checking":
          emitThought(driver.id, `⧉ supervisor checking ${toolLabel}'s result…`);
          break;
        case "accepted":
          review = { verdict: "accepted", text: ev.feedback?.trim() || `Checked ${name}'s work against the task — it does what was asked.` };
          emitThought(driver.id, `✓ supervisor: ${toolLabel} result accepted`);
          break;
        case "insufficient":
          emitThought(
            driver.id,
            `✗ supervisor: insufficient — ${ev.feedback.slice(0, 72) || "missing work"}`,
          );
          break;
        case "exhausted":
          review = { verdict: "stuck", text: `Still short after ${SUPERVISION_MAX_REPROMPTS} send-backs: ${ev.feedback.trim() || "the task isn't done"}. I'll re-plan this part.` };
          emitThought(
            driver.id,
            `⛔ ${toolLabel} failed supervision after ${SUPERVISION_MAX_REPROMPTS} re-prompts — escalating to plan verify`,
          );
          break;
      }
    },
  });
  return { ...outcome, review };
}

// ── Step execution (one pass of the plan) ─────────────────────────────────────

/**
 * Execute every step of one plan pass through the policy-resolved drivers,
 * emitting the canonical PraxisEvents (thinking / task:start / progress /
 * complete / handoff) so the 3D brain animates the work.
 *
 * `supervise` enables the per-delegation evaluate-and-re-prompt loop (needs a
 * brain to judge with - off when Hermes planning is disabled). `brain` is the
 * consistent selection for the whole run.
 */
async function executeSteps(
  plan: OrchPlan,
  supervise: boolean,
  brain: { model: string; provider: string; fallbacks?: BrainRail[] },
  execution: Pick<OrchOptions, "missionId" | "unattended" | "signal" | "ownerToken" | "cwd" | "preferredTool" | "availabilityProbe"> & {
    /** Praxis's own read of the workspace, appended to each delegation's output. */
    darkRails?: Map<DriverTool, string>;
    reroutes?: Set<DriverTool>;
    groundTruth?: () => Promise<string>;
    /** Per-run LIVE ownership map. It survives corrective plan iterations. */
    liveSessions?: Map<string, LiveSessionState>;
    /** Stable random root shared by every owned session in this orchestration run. */
    liveRunKey?: string;
    /** Local evidence checks for explicitly declared step artifacts only. */
    localCheck?: (step: OrchStep) => Promise<DelegationVerdict | null>;
  } = {},
  availability?: FleetAvailability,
): Promise<OrchStepResult[]> {
  const results: OrchStepResult[] = [];
  // Visible tag so the roster/HUD/session-panel surfaces know this work belongs to
  // a long-horizon unattended run, not a normal interactive ask (Pending #1 - see
  // src/orchestrator/unattended.ts for the voice-trigger side).
  const tag = execution.unattended ? " (unattended)" : "";
  // Live availability for this pass. Re-read after a failed step so a rail that
  // just proved dark (drivers.ts remembered it) is not handed the next step.
  let avail = { ...(availability ?? staticAvailability()) };
  const darkRails = execution.darkRails ?? new Map<DriverTool, string>();
  const reroutes = execution.reroutes ?? new Set<DriverTool>();
  execution = { ...execution, darkRails, reroutes };
  for (const [tool, reason] of darkRails) avail[tool] = { tool, usable: false, source: "failure-memory", reason };

  for (let i = 0; i < plan.steps.length; i++) {
    if (execution.signal?.aborted) {
      emitThought("a.praxis", "owned run stopped before step admission");
      break;
    }
    // HALT ALL is checked HERE, before every agent starts, not only between plan
    // iterations: a team plan is 4-5 multi-minute CLI runs, and a breaker thrown
    // mid-plan used to let every remaining step run anyway (live, 2026-09-16).
    if (isHalted()) {
      emitThought("a.praxis", "HALT ALL thrown — no further steps admitted");
      break;
    }
    for (const [tool, reason] of darkRails) avail[tool] = { tool, usable: false, source: "failure-memory", reason };
    for (const tool of ["claude", "codex", "cursor"] as const) if (!isToolEnabled(tool)) avail[tool] = { tool, usable: false, source: "breaker", reason: `${tool} breaker is switched off` };
    const rawStep = plan.steps[i];
    // A plan step without its own cwd runs in the goal's repo, not wherever the
    // app started - the brain's explicit cwd always wins.
    const step: OrchStep = rawStep.cwd || !execution.cwd ? rawStep : { ...rawStep, cwd: execution.cwd };
    const tStep = nowT();

    // ── Policy: resolve a rail that is enabled AND usable right now ───────
    // A LIVE owned session may never silently fall back to a headless rail. If
    // its named rail is unavailable, record that truth and stop this step.
    const route = resolveUsableTool(step.tool, avail, execution.preferredTool);

    if (route.tool === null) {
      // No rail can take this step. Say exactly why - one sentence per dark
      // rail, each naming its fix - and keep the step in the results as a
      // visible skip, never a silent drop.
      emitThought("a.hermes", `⛔ ${route.reason}`);
      results.push({ ...step, output: `${UNROUTABLE}${route.reason}`, ok: false, secs: 0 });
      continue;
    }
    const resolvedTool = route.tool;

    if (resolvedTool !== step.tool) {
      const why = avail[step.tool]?.reason ?? "off";
      if (execution.missionId && !reroutes.has(step.tool)) {
        reroutes.add(step.tool);
        await praxisSay(execution.missionId, "reroute", `${TEAM[step.tool].name} is unavailable: ${why}. ${TEAM[resolvedTool].name} is taking its part.`, {
          agent: TEAM[step.tool].agentId.slice(2) as "forge" | "vega" | "quill",
          standIn: TEAM[resolvedTool].agentId.slice(2) as "forge" | "vega" | "quill",
        });
      }
      emitThought("a.hermes", `rerouted: ${step.tool} → ${resolvedTool} (${why.slice(0, 80)})`);
    }

    const driver = DRIVERS[resolvedTool];

    if (execution.missionId) await praxisSay(execution.missionId, "dispatch", stepLabel(step), {
      agent: TEAM[resolvedTool].agentId.slice(2) as "forge" | "vega" | "quill",
      model: modelForResolvedStep(step, resolvedTool), step: { index: i + 1, of: plan.steps.length },
    });

    // Emit why + task start
    eventBus.emitOrchestrator({
      type: "agent:thinking",
      t: tStep,
      agentId: driver.id, taskId: step.taskId, areaId: step.areaId,
      thought: step.why || `step ${i + 1}/${plan.steps.length}`,
    });
    eventBus.emitOrchestrator({
      type: "task:start",
      t: tStep,
      agentId: driver.id, taskId: step.taskId, areaId: step.areaId,
      label: `${resolvedTool}: ${step.prompt.slice(0, 48)}${tag}`,
    });
    eventBus.emitOrchestrator({
      type: "task:progress",
      t: tStep,
      agentId: driver.id, taskId: step.taskId, areaId: step.areaId,
      progress: i / plan.steps.length,
    });

    // Background / Hybrid: headless driver (claude -p / codex exec) under
    // per-delegation supervision - the driver runs, the brain judges the result
    // against the task, and the SAME tool is re-prompted with concrete feedback
    // when it falls short (bounded by SUPERVISION_MAX_REPROMPTS). runSupervised-
    // Delegation swallows tool throws (returns ok:false), so no try/catch here.
    // (Live mode already returned before this loop via the visible operator.)
    // Model precedence: the brain's own per-step pin ALWAYS wins; only when it
    // omitted one do we fall back to the Fleet panel's persisted default for
    // this tool (Command Center → fleetStore.ts) - never the reverse. The resolved
    // model rides the step into the supervised delegation (and the run ledger).
    // A pin the destination rail cannot run (e.g. a retired Cursor id) is dropped
    // so the CLI default applies, instead of crashing the delegation.
    const supStep = { ...step, model: sanitizeStepModel(resolvedTool, modelForResolvedStep(step, resolvedTool)) };
    const sessionKey = supStep.ownedLive && supStep.cwd
      ? liveSessionKeyFor(execution.liveRunKey ?? newLiveRunKey(), resolvedTool, supStep.cwd)
      : undefined;
    let liveSession: LiveSessionState | undefined;
    if (sessionKey && execution.liveSessions) {
      liveSession = execution.liveSessions.get(sessionKey);
      if (!liveSession) {
        liveSession = { sessionKey, submitted: false, uncertain: false };
        execution.liveSessions.set(sessionKey, liveSession);
      }
    }

    // NOTE: the Flight Deck already surfaces live Codex sessions first-class via
    // the backend transcript scan (flightdeck.rs codex_sessions → build_codex_lanes),
    // so the old praxis://codex-run lifecycle emits here were dead (their only
    // consumer, the v2 CodexRunsPanel, was deleted in the v3 port). Removed.

    const sup = await runSupervisedDelegation(
      driver,
      resolvedTool,
      supStep,
      supervise,
      brain,
      execution.signal,
      execution.groundTruth,
      supStep.ownedLive ? () => execution.localCheck?.(supStep) ?? Promise.resolve(null) : undefined,
      liveSession,
      execution.missionId,
    );
    const { output, ok } = sup;
    // A finished result the supervisor rejected says nothing about the rail's health.
    const toolError = !ok && endedOnToolError(sup.supervision);
    if (execution.missionId) await praxisSay(execution.missionId, "progress",
      output.split("\n").map((line) => line.trim()).filter(Boolean).slice(-2).join("\n").slice(0, 600) || (ok ? "Step completed." : "Step did not finish."),
      { agent: TEAM[resolvedTool].agentId.slice(2) as "forge" | "vega" | "quill" });
    if (execution.missionId && sup.review) {
      await praxisSay(execution.missionId, "review", sup.review.text, {
        agent: TEAM[resolvedTool].agentId.slice(2) as "forge" | "vega" | "quill",
        verdict: sup.review.verdict,
      });
    }

    if (ok && !step.taskId) {
      eventBus.emitOrchestrator({ type: "task:complete", t: nowT(), agentId: driver.id });
    }
    eventBus.emitOrchestrator({ type: "agent:status", t: nowT(), agentId: driver.id, taskId: step.taskId, areaId: step.areaId, status: "idle" });

    results.push({
      ...supStep, // records the model that actually ran (brain pin or fleet default)
      tool: resolvedTool, // the rail that ACTUALLY ran, not the plan's wish
      output,
      ok,
      secs: nowT() - tStep,
      supervision: sup.supervision,
      reprompts: sup.reprompts,
      toolError,
    });

    const unavailable = toolError ? classifyToolFailure(resolvedTool, output) : null;
    if (unavailable && !execution.signal?.aborted && !isHalted()) {
      darkRails.set(resolvedTool, unavailable.reason);
      avail[resolvedTool] = { tool: resolvedTool, usable: false, source: "failure-memory", ...unavailable };
      const next = resolveUsableTool(resolvedTool, avail, "codex");
      if (next.tool) {
        const retried = await executeSteps({ ...plan, steps: [{ ...step, tool: resolvedTool }] }, supervise, brain,
          { ...execution, preferredTool: "codex" }, avail);
        results.push(...retried);
      }
      continue;
    }

    if (!ok) {
      // Re-read so the NEXT step routes around it instead of paying for the same failure again.
      invalidateAvailability();
      try {
        avail = await liveAvailability(true, execution.availabilityProbe);
      } catch {
        avail = staticAvailability();
      }
    }

    if (execution.signal?.aborted) break;

    // Handoff to next step's driver (if any) - resolve first, since the raw
    // plan tool may be killed in Command Center and get rerouted at execution
    // (matches the corrective-steps handoff below); animating a handoff to a
    // disabled tool's agent would be a lie about who's actually running next.
    const next = plan.steps[i + 1];
    if (next) {
      const nextTool = resolveUsableTool(next.tool, avail, execution.preferredTool).tool ?? "codex";
      const nextDriver = DRIVERS[nextTool];
      eventBus.emitOrchestrator({
        type: "agent:handoff",
        t: nowT(),
        agentId: driver.id, taskId: step.taskId, areaId: step.areaId,
        toAgentId: nextDriver.id,
        thought: `→ ${nextTool}`,
      });
    }
  }

  return results;
}

// ── Core orchestration loop ───────────────────────────────────────────────────

/**
 * Orchestrate a goal end-to-end: think → execute → verify → iterate → record.
 *
 * Safe to call in a browser - if Tauri is absent the function emits one
 * "orchestrator offline" thought and returns a stub result immediately.
 */
export async function orchestrate(goal: string, opts?: OrchOptions): Promise<OrchResult> {
  const missionId = opts?.missionId ?? newMissionId();
  const started = Date.now();
  if (!opts?.missionOpened) await postMissionMsg({ missionId, from: "zach", kind: "mission", title: missionTitle(goal), text: goal });
  // Stoppable from the Mission panel (missionControl.ts); a parent signal still stops it too.
  const control = registerMission(missionId, opts?.signal);
  const options = { native: false, ...opts, missionId, missionOpened: true, signal: control.signal };
  let result: OrchResult;
  try {
    result = opts?.ownerToken && !opts.ownerRunRegistered
      ? await startOwnedOrchestration(opts.ownerToken, control.signal, (signal) =>
          orchestrateImpl(goal, { ...options, signal, ownerRunRegistered: true }))
      : await orchestrateImpl(goal, options);
  } catch (err) {
    result = { steps: [], iterations: 0, done: false, summary: String(err) };
  } finally {
    finishMission(missionId, control);
  }
  // The owner pressed Stop on this mission (not a parent stop, which says its own thing).
  if (control.signal.aborted && !opts?.signal?.aborted) {
    const finished = result.steps.filter((s) => s.ok).length;
    await praxisSay(missionId, "failure", `Stopped — you stopped this mission.${finished ? ` ${finished} step${finished === 1 ? " had" : "s had"} finished; the files they wrote are still there.` : " Nothing had finished yet."}`, { status: "failed" });
    return { ...result, missionId, done: false, summary: "Stopped by Zach." };
  }
  if (!result.done && !control.signal.aborted && !isHalted()) {
    try {
      const { deferralFor, scheduleDeferredMission } = await import("./missionDeferral");
      const avail = await liveAvailability(true, opts?.availabilityProbe);
      const d = deferralFor({ steps: result.steps, avail, deferrals: opts?.deferrals ?? 0, now: Date.now() });
      if (d) {
        await praxisSay(missionId, "note", d.text, { status: "running" });
        scheduleDeferredMission({ missionId, goal, intent: opts?.intent, at: d.at, deferrals: (opts?.deferrals ?? 0) + 1 });
        return { ...result, missionId, deferredUntil: d.at, summary: d.text };
      }
    } catch (err) {
      console.error("[mission] deferral check failed:", err);
    }
  }
  const text = result.done
    ? (await import("./missionText")).resultMessage({
        minutes: (Date.now() - started) / 60000,
        title: result.title,
        steps: result.steps,
        benched: result.benched,
        hasPreview: Boolean(result.artifacts?.some((a) => a.kind === "preview")),
        previewOpened: Boolean(result.previewOpened),
      })
    : (await import("./missionText")).failureMessage({ summary: result.summary, steps: result.steps });
  await praxisSay(missionId, result.done ? "result" : "failure", text, {
    status: result.done ? "done" : "failed", artifacts: result.artifacts,
  });
  return { ...result, missionId };
}

async function orchestrateImpl(goal: string, opts?: OrchOptions): Promise<OrchResult> {
  if (opts?.signal?.aborted) {
    return { steps: [], summary: "Stopped before orchestration started.", iterations: 0, done: false };
  }
  const t0 = nowT();
  const { usePraxisStore } = await import("@/store/usePraxisStore");
  const intent = opts?.intent?.trim() || goal;
  const target = usePraxisStore.getState().fileMissionNode(missionTitle(intent));
  const eventBus = missionBus(target);
  const emitThought = (agentId: string, thought: string) => eventBus.emitOrchestrator({ type: "agent:thinking", t: nowT(), agentId, thought });
  eventBus.emitOrchestrator({ type: "journey:status", t: t0, journeyStatus: "active" });

  // ── Guard: no Tauri runtime ────────────────────────────────────────────────
  if (!inTauri()) {
    eventBus.emitOrchestrator({
      type: "agent:thinking",
      t: t0,
      agentId: "a.praxis",
      thought: "orchestrator offline (no runtime)",
    });
    return {
      steps: [{ tool: "codex", prompt: goal, why: "offline stub", output: "", ok: false, secs: 0 }],
      summary: "Orchestrator offline — Tauri runtime not present.",
      iterations: 0,
      done: false,
    };
  }

  // ── Live availability + target folder ─────────────────────────────────────
  // One probe per run (cached 15s across a brain dump's N runs): which rails
  // are enabled AND usable right now. Nothing below hands a step to a rail this
  // snapshot says is dark without saying why.
  let avail: FleetAvailability;
  try {
    avail = await liveAvailability(false, opts?.availabilityProbe);
  } catch {
    avail = staticAvailability();
  }
  // What the goal itself establishes before anything runs (buildChain.ts):
  //   delivery - what Praxis does with the finished result ("open it … maximize it")
  // Repo inference ignores team names: "using Forge" is not a Praxis hint.
  const team = namedTeam(intent);
  // Unknown pool state (offline) does not bench Quill. A named agent that is switched off
  // (the owner's breaker) or can't run right now (Cursor's own-model allowance used up) sits out and
  // the best available agent takes its share.
  const paused: Partial<Record<DriverTool, string>> = {};
  const darkRails = new Map<DriverTool, string>();
  const reroutes = new Set<DriverTool>();
  for (const tool of ["claude", "codex", "cursor"] as const) {
    if (!avail[tool].usable) paused[tool] = avail[tool].reason ?? `${tool} is unavailable`;
  }
  // The owned LIVE backend intentionally refuses Cursor/Quill: it cannot prove
  // the same named chat ownership there yet. Bench it before planning so no
  // LIVE step is quietly sent to a different GUI or demoted to headless work.
  if (currentExecMode() === "live" && isComputerUseEnabled() && team.includes("cursor")) {
    paused.cursor = "Quill's Cursor rail is unavailable for owned LIVE sessions";
  }
  if (isToolEnabled("cursor")) {
    try {
      const pool = await tauriInvoke<CursorPoolSnapshot>("cursor_pool_state", {});
      const exhausted = pool ? cursorPoolExhaustion(pool) : null;
      if (exhausted) paused.cursor = exhausted.reason;
    } catch {
      /* pool unreadable: leave Quill in the team */
    }
  }
  for (const tool of ["claude", "codex", "cursor"] as const) {
    const reason = paused[tool];
    if (reason) {
      darkRails.set(tool, reason);
      avail = { ...avail, [tool]: { tool, usable: false, source: "usage", reason } };
    }
  }
  const adjusted = availableTeam(team, (t) => avail[t].usable, paused);
  const benched = new Map(adjusted.benched.map((b) => [b.tool, b.standIn] as const));
  const teamNote = adjusted.note;
  team.splice(0, team.length, ...adjusted.team);
  if (teamNote) emitThought("a.praxis", teamNote);
  const newProject = !opts?.cwd && isNewProjectGoal(intent);
  const delivery = parseDelivery(intent);
  const inferred = opts?.cwd || newProject ? undefined : repoFolderFor(intent);
  let cwd = opts?.cwd ?? inferred?.folder;
  if (inferred) emitThought("a.praxis", `repo: ${inferred.id} (from "${inferred.hint}") → ${inferred.folder}`);
  if (team.length) emitThought("a.praxis", `team: ${team.map((t) => TEAM[t].name).join(", ")}`);
  const preferredTool = opts?.preferredTool ?? team[0];

  const useNative = opts?.native ?? (currentExecMode() === "background" && team.length < 2 && !newProject);
  if (useNative) {
    try {
      const { flowStart } = await import("./flows");
      // The "delegate"/"overnight" definitions template their claude lanes' model
      // as "{model}" (flow_runner.rs's subst() now applies to the model field too -
      // 2026-07-10 fix) so the NATIVE path honors the same Fleet-panel Forge
      // selection the in-webview loop's defaultModelFor("claude") reads below,
      // instead of the flow JSON's old hardcoded "opus". Falls back to "opus" only
      // if nothing is persisted yet (defaultModelFor returns undefined for "CLI
      // default" - a native flow's lane always needs a concrete model string here,
      // unlike agent_delegate which can omit --model).
      const route = nativeFlowRoute(preferredTool ?? "codex", avail);
      if (!route) throw new Error(unroutableReason(avail));
      const flowId = await flowStart("delegate-v2", {
        goal,
        cwd: cwd ?? "",
        driver: route.tool,
        model: route.model ?? "",
      });
      emitThought("a.praxis", `native flow started (${flowId}) — Praxis is driving the build itself`);
      const secs = nowT() - t0;
      const steps: OrchStepResult[] = [
        {
          tool: route.tool,
          prompt: goal,
          why: opts?.native ? "native FlowRunner (opts.native)" : "native FlowRunner (background mode)",
          output: `flow ${flowId} started`,
          ok: true,
          secs,
        },
      ];
      // No recordRun here - the flow writes its OWN crash-safe state
      // (%LOCALAPPDATA%\Praxis\flows\<flowId>.json) and its own ledger/lessons.
      return {
        steps,
        summary: `Native flow ${flowId} started — Praxis is spawning + verifying the build itself.`,
        iterations: 0,
        done: false, // "started", not "verified done" - the flow reports its own completion
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Trust below III, HALT thrown, or the runtime lacked the command - surface
      // it honestly and fall through to the in-webview loop so the goal isn't lost.
      emitThought("a.praxis", `native flow refused: ${msg.slice(0, 80)} — falling back to in-webview loop`);
    }
  }

  // ── Exec-mode: read + enforce ────────────────────────────────────────────
  const execMode = currentExecMode();
  const hermesOn = isHermesEnabled();
  const computerUseOn = isComputerUseEnabled();

  // Live mode requires Computer Use to be enabled in the kill-bar.
  // If it is off, degrade to Hybrid and tell the owner why.
  // A named TEAM (or a new project) is a multi-agent build: the visible operator
  // below drives ONE Codex window, so it would silently drop Forge and Quill and the
  // memory brief. The team keeps its own pipeline (plan → supervised steps → file
  // gate → verify) and runs IN THE OPEN instead: every step shows where the owner can
  // watch it (Vega's thread in the Codex app, Forge's session in a terminal window)
  // and the build folder opens in Cursor, so the files appear as they are written.
  // The work itself stays on the checked, headless path: typing prompts into three
  // apps' chat boxes by computer use would make every build as fragile as the GUI.
  const teamBuild = team.length >= 2 || newProject;
  const liveTeam = execMode === "live" && computerUseOn && teamBuild;
  // Owner request 2026-09-18: hybrid team builds are SHOWN too (Vega's thread in the Codex app,
  // Forge's view, the folder in Cursor) - opened behind, never taking focus from him or Atlas.
  const hybridTeam = execMode === "hybrid" && teamBuild;
  const showTeam = liveTeam || hybridTeam;
  const effectiveMode =
    execMode === "live" && !computerUseOn ? "hybrid" : execMode;

  if (execMode === "live" && !computerUseOn) {
    eventBus.emitOrchestrator({
      type: "agent:thinking",
      t: t0,
      agentId: "a.hermes",
      thought: "Live mode blocked: Computer Use is off in Tool switches — running Hybrid instead",
    });
  } else if (liveTeam) {
    emitThought(
      "a.hermes",
      "Live mode: the team works in the open — Vega's thread in the Codex app, Forge's session in a terminal window, the build folder in Cursor",
    );
  }

  eventBus.emitOrchestrator({
    type: "agent:thinking",
    t: t0,
    agentId: "a.hermes",
    thought: liveTeam
      ? "mode: live — the team runs where you can watch it; Praxis still checks every step"
      : effectiveMode === "live"
        ? "mode: live — routing steps through visible computer-use operator"
        : effectiveMode === "hybrid"
          ? "mode: hybrid — fast lane in front; heavy goals run headless in the background"
          : "mode: background — fully headless, safe to walk away",
  });

  // This orchestrate() call is the ESCALATION target it hands heavy/multi-step goals to - so
  // from HERE, hybrid behaves like BACKGROUND: fully headless, NO brain-window surfacing, NO QA
  // focus-steal. The old hybrid path (surface the brain window + headless claude -p) is DEAD -
  // while the owner is mid-conversation the escalated build must not yank a window or steal the
  // foreground out from under the fast lane. Progress still streams via eventBus into the
  // session panel. Live keeps its visible operator (below); Background is unchanged. So ONLY
  // Live surfaces a window here.
  if (effectiveMode === "live" && !liveTeam) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("show_main_cmd");
    } catch {
      /* not critical - ignore in dev browser */
    }
  }

  // Live: route the whole goal through the visible Codex computer-use operator.
  // Atlas is the fleet's operator agent (roster id a.atlas).
  // (CU-off was already degraded to hybrid above, so no re-check needed here.)
  if (effectiveMode === "live" && !liveTeam) {
    const step: OrchStep = {
      tool: "codex",
      prompt: goal,
      why: "Live mode routes through visible Codex Computer Use",
    };

    eventBus.emitOrchestrator({
      type: "agent:status",
      t: nowT(),
      agentId: "a.atlas",
      status: "working",
      model: "codex",
    });
    eventBus.emitOrchestrator({
      type: "task:start",
      t: nowT(),
      agentId: "a.atlas",
      label: `visible Codex: ${goal.slice(0, 48)}`,
    });

    try {
      const output = await tauriInvoke<string>("computer_use_operate", {
        goal,
        ownerToken: opts?.ownerToken ?? null,
        // The ONE place origin is genuinely conditional: the same orchestrator
        // serves a turn the owner just typed and a 500-iteration overnight run. An
        // unattended run is gated by the dial; an interactive one is him.
        origin: (opts?.unattended ? "unattended" : "live") satisfies ActionOrigin,
      });
      // HONESTY GATE: computer_use_operate returns Ok for degraded outcomes too
      // (autonomy too low → clipboard handoff; Codex window never found; paste
      // failed). Only a NATIVE fast-path success means the goal actually finished;
      // an auto-submit means Codex has STARTED - not that the goal is done. A
      // handoff means the owner still has to paste it himself. Never cross off a to-do
      // for anything short of a genuinely completed native op.
      const lower = output.toLowerCase();
      const nativeDone = lower.includes("native fast path");
      const started = lower.includes("auto-submitted");
      if (nativeDone) {
        eventBus.emitOrchestrator({ type: "task:complete", t: nowT(), agentId: "a.atlas" });
        void emitTaskComplete(goal);
      }
      eventBus.emitOrchestrator({ type: "agent:status", t: nowT(), agentId: "a.atlas", status: "idle" });
      const secs = nowT() - t0;
      const steps = [{ ...step, output, ok: nativeDone || started, secs }];
      await recordRun(goal, steps, 1, nativeDone, secs);
      return {
        steps,
        summary: nativeDone
          ? "Handled natively — done."
          : started
            ? "Visible Codex Computer Use is running — not yet verified done."
            : "Codex opened with a manual handoff — waiting on you to submit.",
        iterations: 1,
        done: nativeDone,
      };
    } catch (err) {
      const output = err instanceof Error ? err.message : String(err);
      eventBus.emitOrchestrator({
        type: "agent:thinking",
        t: nowT(),
        agentId: "a.atlas",
        thought: `visible Codex error: ${output.slice(0, 72)}`,
      });
      eventBus.emitOrchestrator({ type: "agent:status", t: nowT(), agentId: "a.atlas", status: "idle" });
      const secs = nowT() - t0;
      const steps = [{ ...step, output, ok: false, secs }];
      await recordRun(goal, steps, 1, false, secs);
      return { steps, summary: "Visible Codex Computer Use failed.", iterations: 1, done: false };
    }
  }

  // ── Capacity (live meters) - picks this run's brain and steers the plan ────
  let capacity: FleetCapacity | null = null;
  try {
    capacity = railCapacity(await tauriInvoke<UsageRows>("usage_summary", {}));
  } catch {
    capacity = null;
  }

  // ── Brain selection ────────────────────────────────────────────────────────
  const gatedBrain = selectedBrainWithGate();
  if (gatedBrain.rerouted) {
    emitThought("a.hermes", `Selected brain rail is switched off — thinking on ${railShortLabel(gatedBrain)}`);
  }
  const balancedBrain = capacity ? balanceBrain(gatedBrain, capacity) : { brain: gatedBrain };
  const brain = balancedBrain.brain;
  if (balancedBrain.note) emitThought("a.hermes", balancedBrain.note);
  // How far Praxis may go beyond the literal ask (the owner's trust dial).
  const authority = authorityFor(loadAutonomy());

  // ── Step 1: THINK - ask the brain for a plan ───────────────────────────────
  if (opts?.unattended) {
    emitThought(
      "a.praxis",
      `⚡ unattended run starting — iteration ceiling ${iterationBudget(opts)} ("halt all" or the HALT breaker cancels it)`,
    );
  }
  eventBus.emitOrchestrator({
    type: "agent:thinking",
    t: t0,
    agentId: "a.hermes",
    thought: `⚙ planning${opts?.unattended ? " (unattended)" : ""}: ${goal.slice(0, 60)}${goal.length > 60 ? "…" : ""}`,
  });

  // ── GROUND the run before planning: workspace → memory → brief ────────────
  // A NEW project gets its own folder. Without one the agents would run in
  // whatever directory the app happened to start in - never acceptable.
  let workspace: string | undefined;
  /** Manifest summary of an unfinished build this run continues, if any. */
  let resumedFrom: string | undefined;
  if (newProject) {
    try {
      workspace = await tauriInvoke<string>("workspace_prepare", {
        slug: projectSlug(intent),
        resume: !wantsFreshBuild(intent),
      });
      cwd = workspace;
      try {
        const existing = await tauriInvoke<WorkspaceManifest>("workspace_manifest", { root: workspace });
        if (existing.files.some((f) => f.rel !== ".gitignore" && f.rel !== BRIEF_FILE)) {
          resumedFrom = manifestSummary(existing);
          emitThought("a.praxis", `resuming the unfinished build — ${resumedFrom.slice(0, 140)}`);
        }
      } catch {
        /* unreadable manifest → plan as a fresh build */
      }
      emitThought("a.praxis", `workspace: ${workspace}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const summary = `I couldn't create a build folder, so nothing ran: ${msg.slice(0, 160)}`;
      emitThought("a.praxis", `⛔ ${summary}`);
      await recordRun(goal, [], 0, false, nowT() - t0, undefined, { missionId: opts?.missionId, team, error: summary });
      return { steps: [], summary, iterations: 0, done: false };
    }
  }

  // Live: open the build folder in Cursor before anyone starts, so the owner watches the
  // files appear as the team writes them. A failure here never stops the build.
  const liveFolder = workspace ?? cwd;
  if (showTeam && liveFolder) {
    try {
      const said = await tauriInvoke<string>("live_open_workspace", { path: liveFolder, activate: liveTeam });
      emitThought("a.praxis", said);
    } catch (err) {
      emitThought("a.praxis", `⚠ couldn't open the build folder in Cursor: ${String(err).slice(0, 100)}`);
    }
  }

  // A new web build must open straight from disk - this shapes the plan, every
  // agent prompt, and the file gate.
  const webDeliverable = Boolean(workspace) && isWebDeliverable(intent, delivery);
  const minimalWebProof = webDeliverable && isMinimalWebProofGoal(goal);

  // REAL memory from the Memory Galaxy's own files (memory_graph.rs memory_recall).
  const hits = await recallMemory(goal);
  if (workspace) {
    try {
      await tauriInvoke<string>("workspace_write_file", {
        root: workspace,
        rel: BRIEF_FILE,
        content: formatBrief({ goal, team, workspace, hits, delivery }),
      });
      emitThought("a.praxis", `brief: ${BRIEF_FILE} written with ${hits.length} memory note${hits.length === 1 ? "" : "s"}`);
    } catch (err) {
      emitThought("a.praxis", `⚠ couldn't write ${BRIEF_FILE}: ${String(err).slice(0, 80)} — memory goes in each prompt instead`);
    }
  }
  const memoryBlock = formatMemoryForPrompt(hits);
  // Existing-repo work gets a smaller memory note inline (no brief file in a repo).
  const repoMemory = !workspace && hits.length ? formatMemoryForPrompt(hits, 1800) : "";

  /** Make any plan's steps runnable for THIS run: named team covered (initial plan
   *  only - corrective passes target gaps, not people), models the rail can run,
   *  the workspace pinned, and the brief-reading preamble on every prompt. */
  const groundSteps = (steps: OrchStep[], cover: boolean): OrchStep[] => {
    steps = steps.filter((s) => !isAvailabilityOnlyStep(s.prompt));
    const covered0 = cover && team.length ? (ensureTeamCoverage(steps, team) as OrchStep[]) : steps;
    // A planner can still hand a benched agent a step; its stand-in does it instead.
    const covered = covered0.map((s) => {
      const standIn = benched.get(s.tool) && !darkRails.has(benched.get(s.tool)!) ? benched.get(s.tool) : darkRails.has(s.tool) ? resolveUsableTool(s.tool, Object.fromEntries(Object.entries(avail).map(([t, a]) => [t, darkRails.has(t as DriverTool) ? { ...a, usable: false } : a])) as FleetAvailability, "codex").tool : benched.get(s.tool);
      return standIn
        ? { ...s, tool: standIn, model: standInModel(standIn), why: `${s.why} (${TEAM[standIn].name}, standing in for ${TEAM[s.tool].name})` }
        : s;
    });
    return covered.map((raw) => {
      const s = { ...raw, ...target };
      const model = sanitizeStepModel(s.tool, s.model);
      const visible = showTeam || undefined;
      const ownedLive = liveTeam || undefined;
      if (workspace) {
        const liveModel = liveTeam && s.tool === "claude" ? "claude-sonnet-5-5" : model;
        return { ...s, cwd: workspace, model: liveModel, visible, ownedLive, prompt: teamStepPrompt({ ...s, model: liveModel }, workspace, delivery, webDeliverable) };
      }
      const liveModel = liveTeam && s.tool === "claude" ? "claude-sonnet-5-5" : model;
      return { ...s, model: liveModel, visible, ownedLive, prompt: "Do not write brief files or planning notes in the repository root; keep planning in your reply.\n\n" + (repoMemory ? `${s.prompt}\n\n${repoMemory}` : s.prompt) };
    });
  };

  let plan: OrchPlan;
  let planned = false;

  // Direct-execution rail when there is no plan: the routed/preferred tool if
  // it is usable, else the first usable rail (executeSteps still re-checks).
  const directTool: DriverTool = resolveUsableTool(preferredTool ?? "codex", avail, preferredTool).tool ?? preferredTool ?? "codex";

  if (!hermesOn) {
    // Hermes is disabled - skip the brain call, fall straight to a direct execution step.
    emitThought("a.hermes", `Hermes off - skipping brain plan, delegating directly to ${directTool}`);
    plan = fallbackPlan(goal, directTool);
  } else {
    try {
      const raw = await tauriInvoke<string>("hermes_brain", {
        goal: planPrompt(goal, {
          team, workspace, memory: memoryBlock || undefined, delivery, webDeliverable, existing: resumedFrom,
          authority: authority.text,
          capacity: capacity ? capacityBlock(capacity) : undefined,
        }),
        model: brain.model,
        provider: brain.provider,
        fallbacks: brain.fallbacks,
      });
      const parsed = parsePlan(raw, { allowEmpty: Boolean(workspace && resumedFrom) });
      planned = parsed !== null;
      plan = parsed ?? fallbackPlan(goal, directTool);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitThought("a.hermes", `⚠ brain unavailable: ${msg.slice(0, 50)} — running fallback`);
      plan = fallbackPlan(goal, directTool);
    }
  }

  // A new project with no usable plan still runs as the real team with a real
  // division of labor - never as one blind "do the whole goal" step.
  if (workspace && !planned) {
    const names = (team.length ? team : (["claude", "codex", "cursor"] as DriverTool[])).map((t) => TEAM[t].name);
    plan = {
      steps: (resumedFrom ? resumeTeamPlan(team) : defaultTeamPlan(team)) as OrchStep[],
      summary: `${projectSlug(intent).replace(/-/g, " ")} — ${names.join(", ")}`,
    };
    emitThought("a.hermes", "no usable plan from the brain — running the team's default division of labor");
  }
  // The planner, told what is on disk, picks only the work that is still needed.
  plan = { ...plan, steps: groundSteps(plan.steps, !resumedFrom) };
  // Keep the windows even: a step headed for a nearly-spent rail moves to the peer with room.
  let balanceNote = "";
  if (capacity) {
    const balanced = rebalanceSteps(plan.steps, capacity, (t) => avail[t].usable, team);
    if (balanced.moves.length) {
      plan = { ...plan, steps: balanced.steps };
      balanceNote = `Balanced the load: ${balanced.moves.join("; ")}.`;
      emitThought("a.hermes", balanceNote);
    }
  }

  await praxisSay(opts!.missionId!, "plan", [
    ...plan.steps.map((s) => `${TEAM[s.tool].name}: ${stepLabel(s)}`),
    `Workspace: ${workspace ?? cwd ?? "default working folder"}`, teamNote, balancedBrain.note, balanceNote,
  ].filter(Boolean).join("\n"), { status: "running" });
  if (plan.decisions?.length) {
    await praxisSay(opts!.missionId!, "decision", plan.decisions.map((d) => `• ${d}`).join("\n"));
  }
  if (plan.ideas?.length) {
    await praxisSay(opts!.missionId!, "note", `Ideas for you — not built unless you say so:\n${plan.ideas.map((d) => `• ${d}`).join("\n")}`);
  }
  for (const b of adjusted.benched) {
    reroutes.add(b.tool);
    await praxisSay(opts!.missionId!, "reroute", `${b.why}. ${b.standIn ? `${TEAM[b.standIn].name} is taking ${TEAM[b.tool].name}'s part.` : "No agent is available to take its part."}`, {
      agent: TEAM[b.tool].agentId.slice(2) as "forge" | "vega" | "quill",
      ...(b.standIn ? { standIn: TEAM[b.standIn].agentId.slice(2) as "forge" | "vega" | "quill" } : {}),
    });
  }
  emitThought("a.hermes", `Plan: ${plan.summary}`);
  emitThought(
    "a.hermes",
    `steps: ${plan.steps.map((s, i) => `${i + 1}. ${TEAM[s.tool].name}${s.model ? `/${s.model}` : ""}`).join("  ")}`,
  );

  // Praxis's own read of the effective folder - new build or existing repo. LIVE
  // team steps in an existing repo need the same disk evidence as new projects.
  const manifestRoot = workspace ?? (liveTeam ? cwd : undefined);
  const readManifest = async (root = manifestRoot): Promise<WorkspaceManifest | null> => {
    if (!root) return null;
    try {
      return await tauriInvoke<WorkspaceManifest>("workspace_manifest", { root });
    } catch {
      return null;
    }
  };
  const groundTruth = manifestRoot ? async () => manifestSummary(await readManifest()) : undefined;
  const liveSessions = liveTeam ? new Map<string, LiveSessionState>() : undefined;
  const liveRunKey = liveTeam ? newLiveRunKey() : undefined;
  const localLiveCheck = async (step: OrchStep): Promise<DelegationVerdict | null> => {
    const manifest = await readManifest(step.cwd ?? manifestRoot);
    if (!manifest) {
      return { sufficient: false, feedback: "Praxis could not read the effective workspace folder after this LIVE step; stop and verify the folder before claiming completion." };
    }
    if (step.finalDeliverableCheck) {
      const result = deliverableGate(manifest, { allowMinimal: minimalWebProof });
      return { sufficient: result.ok, feedback: result.ok ? "" : `Praxis deliverable check failed: ${result.reason}. Fix it directly in this workspace.` };
    }
    return expectedFilesCheck(manifest, step.expectedFiles);
  };
  let gate: { ok: boolean; reason: string } | null = null;
  let lastReason = "";

  // ── Steps 2–4: EXECUTE → LOOK (QA) → VERIFY → ITERATE ─────────────────────
  const budget = iterationBudget(opts);
  const results: OrchStepResult[] = [];
  let iterations = 0;
  let done = false;
  let finalSummary = plan.summary;

  // Lens visual QA (foreground-stealing screenshot pass) is now OFF in this loop.
  // Only LIVE mode ever wanted it, and Live returns early through the visible
  // computer-use operator ABOVE (it never reaches this loop). The two modes that
  // DO reach here are Hybrid and Background - both headless: Hybrid is the
  // escalation target of the always-listening fast lane and must not steal the
  // foreground mid-conversation; Background is unattended. So no QA window here.
  // (Kept as a binding so the QA plumbing below stays type-safe and dormant, ready
  // to re-enable if a "watched hybrid" mode is ever reintroduced.)
  const qaWindow: string | undefined = undefined;
  void plan.qaWindow; // brain may still emit it; intentionally unused in headless modes
  let qaPasses = 0;
  // Set when a QA-informed corrective pass is queued - the NEXT iteration re-looks
  // to confirm the visual fixes actually landed (instead of trusting the brain's word).
  let qaRecheckDue = false;
  const qaTotals = { findings: 0, high: 0, med: 0, low: 0 };
  // What Praxis SAW in this pass's screenshots, and whether it already forced one fix pass.
  let lookIssues: string[] = [];
  let lookFixUsed = false;
  // Sovereign: one improvement pass after the goal is met.
  let improvementUsed = false;

  for (let iter = 1; iter <= budget; iter++) {
    iterations = iter;

    // Cooperative cancellation (voice "stop"/"stand down" on an unattended run) -
    // checked at the top of every iteration so a 500-iteration ceiling always has
    // a real stop, not just the eventual budget exhaustion.
    if (opts?.signal?.aborted) {
      emitThought("a.praxis", "run cancelled — stopping before the next iteration");
      done = false;
      break;
    }

    // HALT ALL (Command Center status rail) - a real global stop, checked at the
    // same cadence as the abort signal so the breaker lands mid-run in every mode.
    if (isHalted()) {
      emitThought("a.praxis", "HALT ALL thrown — standing down before the next iteration");
      done = false;
      break;
    }

    if (iter > 1) {
      emitThought(
        "a.praxis",
        `iteration ${iter}/${budget}${opts?.unattended ? " (unattended)" : ""}: ${plan.steps.length} corrective step${plan.steps.length === 1 ? "" : "s"}`,
      );
    }

    // supervise = hermesOn: the per-delegation evaluate/re-prompt loop needs a
    // brain to judge with, the same gate the plan/verify calls use. `brain` is
    // the run's single consistent selection (OpenRouter kill-toggle applied).
    if (iter > 1) {
      // Corrective passes re-read availability: a rail that went dark (or came
      // back - a login, a usage reset) since the first pass must show up here.
      try {
        avail = await liveAvailability(false, opts?.availabilityProbe);
      } catch {
        avail = staticAvailability();
      }
    }
    // The planner judged the build on disk complete: nothing runs, and the files go
    // straight to verification. That is never "every step failed".
    const nothingToRun = Boolean(workspace) && plan.steps.length === 0;
    if (nothingToRun) emitThought("a.hermes", "nothing left to build — verifying the files on disk");
    const beforePass = workspace ? await readManifest() : null;
    let passResults = nothingToRun ? [] : await executeSteps(
      plan,
      hermesOn,
      brain,
      {
        darkRails, reroutes,
        missionId: opts?.missionId,
        unattended: opts?.unattended,
        signal: opts?.signal,
        ownerToken: opts?.ownerToken,
        cwd,
        preferredTool,
        availabilityProbe: opts?.availabilityProbe,
        groundTruth,
        liveSessions,
        liveRunKey,
        localCheck: localLiveCheck,
      },
      avail,
    );
    results.push(...passResults);

    // What is actually on disk after this pass (new projects only).
    let truth: string | undefined;
    let afterPass: WorkspaceManifest | null = null;
    if (workspace) {
      const manifest = await readManifest();
      afterPass = manifest;
      gate = webDeliverable ? deliverableGate(manifest, { allowMinimal: minimalWebProof }) : null;
      truth = `${manifestSummary(manifest)}${gate ? ` Deliverable check: ${gate.ok ? "PASS" : "FAIL"} — ${gate.reason}.` : ""}`;
      // Lens measures the page in a real browser before the verdict, so "is it done?" rests
      // on facts (overflow, broken images, JS errors) instead of an agent's description -
      // Forge cannot open a browser and live 2026-09-17 wrote 46 KB of guesses instead.
      if (webDeliverable && gate?.ok) {
        try {
          emitThought("a.lens", "Lens checking the page in a real browser (390 / 768 / 1440 px)…");
          const lens = await tauriInvoke<{ bullets: string[]; screenshots?: string[] }>("lens_qa_workspace", { path: workspace });
          const measured = (lens?.bullets ?? []).join(" ");
          if (measured) {
            truth = `${truth} Lens, measured in a real browser: ${measured}`;
            emitThought("a.lens", measured.slice(0, 200));
          }
          // Praxis LOOKS at it - the screenshots Lens just took, judged against the goal.
          lookIssues = [];
          // Lens writes one full-page screenshot per width into the build's .praxis-qa folder.
          const shots = [390, 768, 1440].map((w) => `${workspace}\\.praxis-qa\\lens-${w}.png`);
          const look = await lookAtBuild(goal, lens?.screenshots?.length ? lens.screenshots : shots);
          if (look) {
            lookIssues = look.ok ? [] : look.issues;
            truth = `${truth} Praxis looked at the screenshots: ${look.verdict || (look.ok ? "it looks right" : "it needs work")}${look.issues.length ? ` Visible issues: ${look.issues.join("; ")}.` : ""}`;
            if (opts?.missionId) {
              await praxisSay(opts.missionId, "review",
                `Looked at it on phone, tablet and desktop — ${look.verdict || (look.ok ? "it looks right" : "it needs work")}${look.issues.length ? `\n${look.issues.map((i) => `• ${i}`).join("\n")}` : ""}`,
                { verdict: look.ok ? "accepted" : "revise" });
            }
          }
        } catch {
          /* Lens unavailable: verify on the file facts alone, as before */
        }
      }
      emitThought("a.praxis", truth.slice(0, 200));
    }

    // The whole-site gate belongs AFTER the content/build/polish pass, never on
    // an early CONTENT.md step. In LIVE, a real failed disk check is stronger
    // than a model's acceptance: repair it in the builder's already-owned chat.
    // `superviseDelegation` bounds this to its initial attempt plus two retries.
    if (liveTeam && workspace && webDeliverable && gate && !gate.ok && passResults.length && !opts?.signal?.aborted) {
      const builder = [...passResults].reverse().find((s) => s.expectedFiles?.some((f) => f.toLowerCase() === "index.html"));
      const builderKey = builder?.cwd ? liveSessionKeyFor(liveRunKey ?? "", builder.tool, builder.cwd) : undefined;
      const builderSession = builderKey ? liveSessions?.get(builderKey) : undefined;
      if (!builder || !builderSession?.submitted || builderSession.uncertain) {
        emitThought("a.praxis", "LIVE file check failed, but no confirmed owned builder chat is available for a safe follow-up; leaving the gate failed for plan repair.");
      } else {
      const repairTool = builder.tool;
      const repair: OrchStep = {
        tool: repairTool,
        cwd: workspace,
        model: builder?.model ?? (repairTool === "claude" ? "sonnet" : undefined),
        ownedLive: true,
        visible: true,
        ...target,
        finalDeliverableCheck: true,
        why: "Praxis final deliverable gate failed",
        prompt: `Praxis's final on-disk deliverable check failed: ${gate.reason}. Fix that exact failure in the existing workspace now. Do not merely describe it; edit the files and leave a static site that passes the check.`,
      };
      emitThought("a.praxis", `LIVE file check failed — re-prompting ${TEAM[repairTool].name}'s owned chat: ${gate.reason}`);
      const repairResults = await executeSteps(
        { steps: [repair], summary: "LIVE final-gate repair" },
        hermesOn,
        brain,
        {
          darkRails, reroutes,
          missionId: opts?.missionId,
          unattended: opts?.unattended,
          signal: opts?.signal,
          ownerToken: opts?.ownerToken,
          cwd,
          preferredTool,
          availabilityProbe: opts?.availabilityProbe,
          groundTruth,
          liveSessions,
          liveRunKey,
          localCheck: localLiveCheck,
        },
        avail,
      );
      passResults = [...passResults, ...repairResults];
      results.push(...repairResults);
      const repairedManifest = await readManifest();
      afterPass = repairedManifest;
      gate = deliverableGate(repairedManifest, { allowMinimal: minimalWebProof });
      truth = `${manifestSummary(repairedManifest)} Deliverable check: ${gate.ok ? "PASS" : "FAIL"} — ${gate.reason}.`;
      emitThought("a.praxis", truth.slice(0, 200));
      }
    }
    const gateOk = gate ? gate.ok : true;

    if (opts?.signal?.aborted) {
      emitThought("a.praxis", "run cancelled — no downstream verification admitted");
      done = false;
      break;
    }
    // A breaker thrown mid-plan stops the remaining steps (executeSteps); the run
    // then stands down - it is never verified "done" with steps skipped.
    if (isHalted()) {
      emitThought("a.praxis", "HALT ALL thrown — standing down without verifying");
      lastReason = "stopped by HALT ALL before every step ran";
      done = false;
      break;
    }

    const anyOk = passResults.some((r) => r.ok);
    // Steps that time out or hit a usage limit can still leave real work on disk.
    // Live 2026-09-16 every step "failed" while a 65 KB site sat in the workspace and
    // the loop stopped without verifying it. The files decide, not the exit codes.
    const progressed = workspace ? manifestChanged(beforePass, afterPass) : false;
    if (!anyOk && progressed) {
      emitThought("a.praxis", "no step reported success, but the workspace changed — verifying what is on disk");
    }
    // What may count as evidence the goal was met when no brain verdict is available.
    const evidence = anyOk || progressed || (nothingToRun && gate?.ok === true);

    if (!anyOk && !progressed && !nothingToRun) {
      // Every tool failed this pass - re-planning with the same broken tools
      // would spin; stop and report honestly. When every step was UNROUTABLE
      // the summary is the routing reason itself (which names the fix), not
      // the plan's cheerful headline.
      const unroutable = passResults.filter((r) => r.output.startsWith(UNROUTABLE));
      if (unroutable.length === passResults.length && unroutable.length > 0) {
        finalSummary = `Nothing ran — ${unroutable[0].output.slice(UNROUTABLE.length)}.`;
        emitThought("a.hermes", "no step could be routed to a usable rail — stopping the loop");
      } else {
        finalSummary = passResults.filter((r) => !r.ok).map((r) => `${TEAM[r.tool].name}: ${r.output.slice(0, 180)}`).join("; ") || "No deliverable steps could run.";
        lastReason = finalSummary;
        emitThought("a.hermes", "every step failed this pass — stopping the loop");
      }
      done = false;
      break;
    }

    if (!hermesOn) {
      // No brain to verify with - single-pass contract (previous behavior), but a
      // new build is never "done" while its files fail Praxis's own check.
      done = evidence && gateOk;
      if (!gateOk) lastReason = gate?.reason ?? "";
      break;
    }

    // ── DRIFT CHECK (unattended long-runs only) ───────────────────────────────
    // Every DRIFT_CHECK_EVERY cumulative steps, a lightweight brain call checks
    // whether accumulated work still tracks the ORIGINAL goal - catching scope
    // creep, tool thrashing, or wrong-area repetition before they compound.
    // Advisory: never changes loop flow; the following VERIFY step re-anchors.
    if (opts?.unattended && results.length > 0 && results.length % DRIFT_CHECK_EVERY === 0) {
      try {
        const driftRaw = await tauriInvoke<string>("hermes_brain", {
          goal: driftPrompt(goal, results),
          model: brain.model,
          provider: brain.provider,
          fallbacks: brain.fallbacks,
        });
        const driftObj = JSON.parse(stripFences(driftRaw)) as unknown;
        const aligned =
          typeof driftObj === "object" && driftObj !== null
            ? (driftObj as { aligned?: unknown }).aligned !== false
            : true; // fail open: parse error → assume aligned
        emitThought(
          "a.praxis",
          aligned
            ? `✓ drift check (${results.length} steps): still on goal`
            : `⚠ drift detected at step ${results.length} — re-anchoring via verify`,
        );
      } catch {
        /* drift check unavailable - continue normally */
      }
    }

    if (opts?.signal?.aborted) {
      done = false;
      break;
    }

    // ── LOOK - Lens visual QA pass (hybrid-only in practice: live mode early-
    // returns through the visible operator before this loop; background never
    // sets qaWindow). Runs AFTER this pass's steps and BEFORE verify so the
    // brain judges the goal with the app's real pixels in evidence. Slots:
    // first iteration (baseline) + the iteration right after a QA-informed
    // corrective pass (confirm the fixes actually landed), ≤ QA_MAX_PASSES.
    // A failed/unavailable pass yields no findings block and never fails the
    // run - the verify simply proceeds without visual context.
    let qaContext: string | undefined;
    let passHighMed = 0;
    if (qaWindow && qaPasses < QA_MAX_PASSES && (iter === 1 || qaRecheckDue)) {
      qaPasses++;
      qaRecheckDue = false;
      const findings = await runQaPassGuarded(qaWindow);
      if (findings !== null) {
        const counts = severityCounts(findings);
        qaTotals.findings += findings.length;
        qaTotals.high += counts.high;
        qaTotals.med += counts.med;
        qaTotals.low += counts.low;
        passHighMed = counts.high + counts.med;
        qaContext = formatQaBlock(qaWindow, findings);
      }
    }

    if (opts?.signal?.aborted) {
      done = false;
      break;
    }

    // ── VERIFY - feed the results back to the brain: genuinely done? ────────
    emitThought("a.hermes", `⚖ verifying (${iter}/${budget}): is the goal genuinely done?`);

    let verdict: OrchVerdict | null = null;
    try {
      const raw = await tauriInvoke<string>("hermes_brain", {
        goal: verifyPrompt(goal, results, qaContext, truth, delivery, adjusted.benched, {
          authority: authority.text,
          improvementsAllowed: authority.sovereign && !improvementUsed,
        }),
        model: brain.model,
        provider: brain.provider,
        fallbacks: brain.fallbacks,
      });
      verdict = parseVerdict(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitThought("a.hermes", `⚠ verify unavailable: ${msg.slice(0, 50)} — accepting results as-is`);
      done = evidence && gateOk;
      if (!gateOk) lastReason = gate?.reason ?? "";
      break;
    }

    if (opts?.signal?.aborted) {
      done = false;
      break;
    }

    if (verdict === null) {
      emitThought("a.hermes", "verify returned no usable verdict — accepting results as-is");
      done = evidence && gateOk;
      if (!gateOk) lastReason = gate?.reason ?? "";
      break;
    }

    // ── DELIVERY is not unfinished work (CODE backstop for the verify prompt) ──
    // When the files pass and every remaining "corrective" step only asks to open,
    // serve or maximize the result, the build IS done - Praxis delivers it next.
    if (
      !verdict.done &&
      delivery?.open &&
      gate?.ok &&
      verdict.steps.length > 0 &&
      verdict.steps.every((s) => isDeliveryOnlyStep(s.prompt))
    ) {
      emitThought("a.praxis", "verdict only asked to open the result — that is Praxis's own delivery step, so the build is done");
      verdict = { ...verdict, done: true, steps: [], reason: `files verified; delivery is next (${verdict.reason.slice(0, 60)})` };
    }

    // ── FILE done-gate (CODE, not prompt): a new website is not done while its
    // entry page is missing, empty, untitled or full of placeholder text - no
    // matter how confident the brain or the agents sound.
    if (verdict.done && gate && !gate.ok) {
      emitThought("a.praxis", `blocking done: ${gate.reason}`);
      const fixer: DriverTool = team.includes("codex") ? "codex" : team[0] ?? "codex";
      verdict = {
        ...verdict,
        done: false,
        reason: `file check failed: ${gate.reason}`,
        steps:
          verdict.steps.length > 0
            ? verdict.steps
            : [
                {
                  tool: fixer,
                  prompt: `Praxis's file check failed: ${gate.reason}. Make the site complete per ${BRIEF_FILE}.`,
                  why: "deliverable gate failed",
                },
              ],
      };
    }

    // ── QA done-gate (CODE, not prompt): the brain may not declare done over
    // standing high/med visual findings from THIS pass. If it tries, override
    // and synthesize a corrective step from the findings so the loop actually
    // fixes them (bounded by the iteration budget + QA pass cap).
    if (verdict.done && passHighMed > 0) {
      emitThought(
        "a.lens",
        `blocking done: ${passHighMed} unfixed high/med visual finding${passHighMed === 1 ? "" : "s"}`,
      );
      verdict = {
        ...verdict,
        done: false,
        reason: `visual QA found ${passHighMed} high/med defect(s) still standing`,
        steps:
          verdict.steps.length > 0
            ? verdict.steps
            : [
                {
                  tool: "codex",
                  prompt: `Fix these visual defects found by QA inspection of the '${qaWindow}' window. ${qaContext ?? ""}`,
                  why: "corrective pass for standing visual QA findings",
                },
              ],
      };
    }

    // ── LOOK done-gate: Praxis saw visible problems in the screenshots. One forced
    // fix pass (a look is a judgment, so it never loops); the next verify decides.
    if (verdict.done && lookIssues.length > 0 && !lookFixUsed) {
      lookFixUsed = true;
      const fixer: DriverTool = avail.cursor.usable ? "cursor" : avail.codex.usable ? "codex" : team[0] ?? "codex";
      emitThought("a.praxis", `blocking done once: Praxis saw ${lookIssues.length} visible issue(s) in the screenshots`);
      verdict = {
        ...verdict,
        done: false,
        reason: `Praxis looked at it and saw: ${lookIssues.slice(0, 2).join("; ")}`,
        steps: verdict.steps.length > 0 ? verdict.steps : [{
          tool: fixer,
          model: standInModel(fixer),
          prompt: `Praxis looked at the finished page in phone, tablet and desktop screenshots and saw these problems. Fix them in the workspace files and keep everything that already works:\n${lookIssues.map((i) => `- ${i}`).join("\n")}`,
          why: "visible issues Praxis saw in the screenshots",
        }],
      };
    }

    emitThought(
      "a.hermes",
      verdict.done
        ? `✓ done: ${verdict.reason || "goal verified"}`
        : `↻ not done: ${verdict.reason || "corrective pass needed"}`,
    );
    lastReason = verdict.reason || lastReason;

    // Praxis's judgment of the whole result, said in Mission.
    if (opts?.missionId) {
      await praxisSay(opts.missionId, "review",
        verdict.done
          ? `Final check passed — ${sentence(verdict.reason) || "the goal is met"}.`
          : `Not done yet — ${sentence(verdict.reason) || "more work needed"}.${verdict.steps.length ? ` Next: ${verdict.steps.map((s) => `${TEAM[s.tool].name} — ${stepLabel(s)}`).join("; ")}` : ""}`,
        { verdict: verdict.done ? "accepted" : "revise" });
      if (verdict.decisions?.length) {
        await praxisSay(opts.missionId, "decision", verdict.decisions.map((d) => `• ${d}`).join("\n"));
      }
    }

    // Sovereign: the goal is met, and Praxis makes it better once before handing it over.
    if (verdict.done && authority.sovereign && !improvementUsed && (verdict.improvements?.length ?? 0) > 0 && iter < budget) {
      improvementUsed = true;
      const steps = groundSteps(verdict.improvements!, false);
      plan = { steps, summary: verdict.summary || plan.summary };
      if (verdict.summary) finalSummary = verdict.summary;
      if (opts?.missionId) {
        await praxisSay(opts.missionId, "decision", `The goal is met. On Sovereign, I'm making it better before handing it over:\n${steps.map((s) => `• ${TEAM[s.tool].name}: ${stepLabel(s)}`).join("\n")}`);
      }
      continue;
    }

    if (verdict.done) {
      done = true;
      if (verdict.summary) finalSummary = verdict.summary;
      break;
    }

    if (verdict.steps.length === 0) {
      emitThought("a.hermes", "brain says not done but gave no corrective steps — stopping");
      done = false;
      break;
    }

    // The next pass acts on visual findings - schedule a confirmation re-look.
    if (passHighMed > 0) qaRecheckDue = true;

    if (iter === budget) {
      emitThought("a.hermes", `iteration budget (${budget}) exhausted — stopping with goal incomplete`);
      done = false;
      break;
    }

    // ── REPROMPT - the brain's corrective steps become the next pass ────────
    plan = { steps: groundSteps(verdict.steps, false), summary: verdict.summary || plan.summary };
    if (capacity) plan = { ...plan, steps: rebalanceSteps(plan.steps, capacity, (t) => avail[t].usable, team).steps };
    if (verdict.summary) finalSummary = verdict.summary;
    const firstTool = resolveUsableTool(plan.steps[0].tool, avail, preferredTool).tool ?? "codex";
    eventBus.emitOrchestrator({
      type: "agent:handoff",
      t: nowT(),
      agentId: "a.hermes",
      toAgentId: DRIVERS[firstTool].id,
      thought: "corrective steps",
    });
  }

  // Close the mission node. The final tick comes FIRST: task:progress re-activates a task in
  // the store, and arriving after task:complete it left every finished mission counted as
  // "1 ACTIVE" with the HUD stuck on EXECUTING (live 2026-10-01). A run that did not finish
  // (failed, or queued for capacity) stops being active without claiming completion.
  if (done) {
    eventBus.emitOrchestrator({ type: "task:progress", ...target, t: nowT(), agentId: "a.hermes", progress: 1 });
    eventBus.emitOrchestrator({ type: "task:complete", t: nowT(), ...target });
    eventBus.emitOrchestrator({ type: "journey:status", t: nowT(), ...target, journeyStatus: "done" });
  } else {
    eventBus.emitOrchestrator({ type: "task:stop", t: nowT(), ...target });
  }

  // ── Auto-cross-off: only when the goal is genuinely done ──────────────────
  if (done && results.some((r) => r.ok)) {
    // Prefer an explicit task id from the first successful step - direct match,
    // no fuzzy logic needed. Fall back to token-overlap on the goal string.
    const successId = results.find((r) => r.ok && r.id)?.id;
    void emitTaskComplete(goal, successId);
  }

  // ── DELIVER - "then open it in a browser and maximize it" ──────────────────
  // Only a verified-done build is shown to the owner, and the window maximized is the
  // one showing THIS page (found by its title), never whatever happens to be in front.
  let delivered: DeliveryResult | null = null;
  const finalManifest = workspace || cwd ? await readManifest(workspace ?? cwd) : null;
  const artifacts: MissionArtifact[] = [];
  if (workspace ?? cwd) artifacts.push({ kind: "folder", label: "Open folder", target: (workspace ?? cwd)! });
  if (finalManifest?.entry) artifacts.push({ kind: "preview", label: "Open preview", target: `file:///${finalManifest.entry.abs.replace(/\\/g, "/").split("/").map((part, i) => i === 0 ? part : encodeURIComponent(part)).join("/")}` });
  if (done && workspace) {
    // Mark the build finished so a later same-day ask starts fresh instead of
    // "resuming" work that is already verified done.
    try {
      await tauriInvoke<string>("workspace_write_file", {
        root: workspace,
        rel: DONE_MARKER,
        content: `${new Date().toISOString()}\n${goal}\n`,
      });
    } catch {
      /* best effort - a missing marker only means a re-ask resumes instead of starting fresh */
    }
  }
  const autoOpen = done && !opts?.unattended && webDeliverable && Boolean(finalManifest?.entry);
  if (done && (delivery?.open || autoOpen) && !opts?.signal?.aborted && !isHalted()) {
    const entry = finalManifest?.entry ?? null;
    const openIntent: DeliveryIntent = delivery?.open ? delivery : { open: true, maximize: false };
    if (entry) {
      emitThought("a.atlas", `opening ${entry.rel}${openIntent.maximize ? " and maximizing it" : ""}`);
      delivered = await deliverResult(entry, openIntent, tauriInvoke);
      emitThought("a.atlas", delivered.message.slice(0, 160));
    } else {
      delivered = { opened: false, maximized: false, message: "There was no page to open." };
    }
  }

  if (workspace) {
    const title = finalManifest?.entry?.title;
    const names = (list: string[]) => (list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}` : list[0]);
    const who = [...new Set(results.filter((r) => r.ok).map((r) => TEAM[r.tool].name))];
    // An agent whose step timed out may still have changed the files; say so rather
    // than silently dropping it from the credit.
    const short = [...new Set(results.filter((r) => !r.ok).map((r) => TEAM[r.tool].name))].filter((n) => !who.includes(n));
    const byWhom = who.length
      ? ` — built by ${names(who)}${short.length ? ` (${names(short)} didn't finish ${short.length > 1 ? "their steps" : "its step"})` : ""}`
      : "";
    finalSummary = done
      ? `${title ? `"${title}"` : "The build"} is done in ${workspace}${byWhom}.${delivered ? ` ${delivered.message}` : ""}`
      : `The build in ${workspace} isn't verified done yet${lastReason ? `: ${lastReason}` : "."}`;
    if (teamNote) finalSummary = `${finalSummary} ${teamNote}`;
  }

  // ── Step 5: RECORD - persist the run (Ledger seed) ─────────────────────────
  const qaSummary: QaRunSummary | undefined =
    qaWindow && qaPasses > 0 ? { window: qaWindow, passes: qaPasses, ...qaTotals } : undefined;
  await recordRun(goal, results, iterations, done, nowT() - t0, qaSummary, {
    missionId: opts?.missionId, workspace: workspace ?? cwd, artifacts,
    team,
    ...(workspace ? { workspace, files: finalManifest?.files.length ?? 0, entry: finalManifest?.entry?.rel ?? null } : {}),
    memory: hits.map((h) => ({ label: h.label, path: h.path })),
    ...(gate ? { gate } : {}),
    ...(delivered ? { delivery: delivered } : {}),
  });

  return {
    steps: results, summary: finalSummary, iterations, done, workspace: workspace ?? cwd, artifacts,
    title: finalManifest?.entry?.title ?? null,
    previewOpened: delivered?.opened ?? false,
    benched: adjusted.benched,
  };
}

/**
 * Pull the memory relevant to a goal from the Memory Galaxy's own files
 * (memory_graph.rs `memory_recall`). Leads with who the owner is when the goal is
 * personal. Never fails the run: an unavailable recall is said out loud and the
 * plan proceeds without memory.
 */
async function recallMemory(goal: string): Promise<MemoryHit[]> {
  try {
    const hits = await tauriInvoke<MemoryHit[]>("memory_recall", {
      query: memoryQuery(goal),
      limit: 8,
      includeProfile: wantsProfile(goal),
    });
    const list = Array.isArray(hits) ? hits : [];
    emitThought(
      "a.praxis",
      list.length
        ? `memory: ${list.length} notes from the Memory Galaxy — ${list.slice(0, 4).map((h) => h.label).join("; ")}`
        : "memory: nothing relevant in the Memory Galaxy for this goal",
    );
    if (list.length) {
      void import("@tauri-apps/api/event")
        .then(({ emit }) =>
          emit("praxis://memory-recalled", {
            goal,
            notes: list.map((h) => ({ label: h.label, path: h.path, galaxyId: h.galaxy_id ?? null })),
          }),
        )
        .catch(() => {});
    }
    return list;
  } catch (err) {
    emitThought("a.praxis", `⚠ memory recall unavailable: ${String(err).slice(0, 90)} — planning without memory`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Brain dump → N real runs (2026-09-12)
//
//   splitBrainDump  →  one task per ask (verbatim words, kind, repo)
//   routeTaskKind   →  a rail that is enabled AND usable right now, or WHY not
//   orchestrate()   →  the EXISTING agent_delegate loop, one run per task
//   ownedRuns ledger → every task gets a run id, tool, folder, terminal state
//
// Nothing here is a second dispatch mechanism: each routable task is exactly
// one orchestrate() call with cwd + preferredTool set. Notes are filed, not
// dispatched. Unroutable tasks are QUEUED with the sentence that names the fix.
// Unclassified pieces stay in the list. If nothing can run, the summary says
// exactly that - a dump that quietly produces nothing is the worst outcome.
// ═══════════════════════════════════════════════════════════════════════════

export interface BrainDumpReport {
  dumpId: string;
  /** Verbatim dump. */
  text: string;
  tasks: BrainDumpTask[];
  /** One record per task, in spoken order, at its terminal state. */
  runs: BrainDumpRunRecord[];
  dispatched: number;
  queued: number;
  noted: number;
  unclassified: number;
  /** Honest one-liner (ownedRuns.brainDumpRunSummary). */
  summary: string;
}

export interface BrainDumpOptions extends Omit<OrchOptions, "cwd" | "preferredTool" | "native"> {
  /** How many routable tasks run at once (default 2; each is a real CLI process). */
  concurrency?: number;
  /** @internal Per-task runner seam - defaults to orchestrate(). Headless tests inject. */
  runTask?: (goal: string, opts: OrchOptions) => Promise<OrchResult>;
  /** @internal Folder probe - defaults to Tauri path_exists; tests inject. */
  folderExists?: (folder: string) => Promise<boolean>;
  /** @internal Fixed dump id (tests). */
  dumpId?: string;
}

/**
 * A dispatched dump, in the shape every single-goal caller already consumes.
 *
 * `done` is true only when every piece finished for real: a run verified done, or a note filed.
 */
export function brainDumpAsOrchResult(report: BrainDumpReport): OrchResult {
  const finished =
    report.runs.length > 0 && report.runs.every((r) => r.state === "done" || r.state === "noted");
  return { steps: [], summary: report.summary, iterations: 1, done: finished };
}

/** The words a worker receives for one task: the ask, its kind, its origin. */
export function brainDumpTaskPrompt(task: BrainDumpTask): string {
  const lines = [task.ask];
  if (task.kind === "investigate") {
    lines.push("Kind: investigate — find out what happened and report the cause with evidence; do not change product code unless the fix is obvious and tiny.");
  } else {
    lines.push("Kind: build — implement it, run the repo's own checks (typecheck/tests), and report exactly what changed.");
  }
  if (task.repo) lines.push(`Repo: ${task.repo.folder} (implied by "${task.repo.hint}")`);
  if (task.text !== task.ask) lines.push(`Original words: "${task.text}"`);
  return lines.join("\n");
}

async function defaultFolderExists(folder: string): Promise<boolean> {
  try {
    return await tauriInvoke<boolean>("path_exists", { path: folder });
  } catch {
    return true; // can't probe ⇒ don't invent a missing folder; the tool will say so
  }
}

/** Bounded parallel map that preserves order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Turn one brain dump into real dispatched work and a ledger of what happened.
 * Resolves when every routable task is TERMINAL (done/failed/stopped) - never
 * on "started". Safe in a plain browser: orchestrate() returns its offline stub
 * and each run records "failed" with that reason.
 */
export async function dispatchBrainDump(text: string, opts: BrainDumpOptions = {}): Promise<BrainDumpReport> {
  const dumpId = opts.dumpId ?? nextBrainDumpRunId("dump");
  const tasks = splitBrainDump(text);
  const runTask = opts.runTask ?? ((goal, o) => orchestrate(goal, o));
  const folderExists = opts.folderExists ?? defaultFolderExists;

  if (tasks.length === 0) {
    const summary = brainDumpRunSummary([]);
    emitThought("a.praxis", summary);
    return { dumpId, text, tasks, runs: [], dispatched: 0, queued: 0, noted: 0, unclassified: 0, summary };
  }

  let avail: FleetAvailability;
  try {
    avail = await liveAvailability(false, opts.availabilityProbe);
  } catch {
    avail = staticAvailability();
  }

  emitThought("a.praxis", `brain dump → ${tasks.length} task${tasks.length === 1 ? "" : "s"}`);

  // ── Register every task FIRST, so the ledger shows N rows before any run ──
  const records: BrainDumpRunRecord[] = tasks.map((task) => {
    const base: BrainDumpRunRecord = {
      runId: nextBrainDumpRunId(),
      dumpId,
      taskId: task.id,
      text: task.text,
      ask: task.ask,
      kind: task.kind,
      tool: null,
      folder: task.repo?.folder ?? null,
      state: "queued",
      reason: null,
      summary: null,
      steps: 0,
      okSteps: 0,
      startedAt: Date.now(),
      endedAt: null,
    };
    if (task.kind === "note") {
      base.state = "noted";
      base.summary = "kept as a note — filed, not sent or dispatched anywhere";
      base.endedAt = Date.now();
    } else if (task.kind === "unclassified") {
      base.state = "unclassified";
      base.reason = "I couldn't tell whether this is a build, an investigation or a note — say which and I'll route it";
      base.endedAt = Date.now();
    } else {
      const route = routeTaskKind(task.kind, avail);
      if (route.tool === null) {
        base.reason = route.reason; // queued: every dark rail's fix, in one sentence
        base.endedAt = Date.now();
        emitThought("a.praxis", `queued "${task.ask.slice(0, 48)}" — ${route.reason.slice(0, 120)}`);
      } else {
        base.tool = route.tool;
      }
    }
    return recordBrainDumpRun(base);
  });

  // ── Dispatch the routable ones through the ONE existing loop ──────────────
  const routable = records.filter((r) => r.tool !== null && r.state === "queued");
  await mapPool(routable, opts.concurrency ?? 2, async (rec) => {
    const task = tasks.find((t) => t.id === rec.taskId)!;
    if (opts.signal?.aborted) {
      patchBrainDumpRun(rec.runId, { state: "stopped", reason: "stopped before dispatch", endedAt: Date.now() });
      return;
    }
    if (rec.folder && !(await folderExists(rec.folder))) {
      patchBrainDumpRun(rec.runId, {
        state: "queued",
        reason: `folder ${rec.folder} is not on this machine — check the checkout path`,
        endedAt: Date.now(),
      });
      return;
    }
    patchBrainDumpRun(rec.runId, { state: "running", startedAt: Date.now() });
    emitThought("a.praxis", `▶ ${rec.tool}: "${task.ask.slice(0, 56)}"${rec.folder ? ` in ${rec.folder}` : ""}`);
    try {
      // Strip the dispatcher-only fields; everything else rides into orchestrate().
      const { concurrency: _concurrency, runTask: _runTask, folderExists: _folderExists, dumpId: _dumpId, ...orchOpts } = opts;
      const result = await runTask(brainDumpTaskPrompt(task), {
        ...orchOpts,
        cwd: rec.folder ?? undefined,
        preferredTool: rec.tool ?? undefined,
      });
      const okSteps = result.steps.filter((s) => s.ok).length;
      const ranTool = result.steps.find((s) => s.ok)?.tool ?? result.steps[0]?.tool ?? rec.tool;
      patchBrainDumpRun(rec.runId, {
        state: opts.signal?.aborted && !result.done ? "stopped" : result.done ? "done" : "failed",
        tool: ranTool,
        summary: result.summary || null,
        reason: result.done ? null : result.summary || "did not reach a verified done",
        steps: result.steps.length,
        okSteps,
        endedAt: Date.now(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patchBrainDumpRun(rec.runId, { state: "failed", reason: msg.slice(0, 200), endedAt: Date.now() });
    }
  });

  const runs = listBrainDumpRuns(dumpId);
  const summary = brainDumpRunSummary(runs);
  emitThought("a.praxis", summary);
  return {
    dumpId,
    text,
    tasks,
    runs,
    dispatched: runs.filter((r) => r.tool !== null && r.state !== "queued").length,
    queued: runs.filter((r) => r.state === "queued").length,
    noted: runs.filter((r) => r.state === "noted").length,
    unclassified: runs.filter((r) => r.state === "unclassified").length,
    summary,
  };
}
