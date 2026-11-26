/**
 * Faculty B -- the chat-path ("continuous planner"), MOCK (spec §B.3).
 *
 * A deterministic canned responder that READS the journey model to answer:
 * what's next and how far along each lane is. Journey `active` is roadmap state,
 * not proof that a real worker is running; live runtime truth belongs to Flight
 * Deck / the agent telemetry surfaces. No model
 * call, zero spend -- but the panel is shaped so the real event-driven
 * orchestrator can replace this function later with no UI change.
 *
 * Phase-3 addition: `tryOrchestrate` detects build-intent queries and hands
 * them off to the real orchestrator (hermes_brain → driver agents). Passive
 * status queries still hit the deterministic mock below.
 */

import { buildGraph } from "@/data/graph";
import {
  STATUS_RANK,
  nextUp,
  storyOrder,
  type JourneyMilestone,
} from "@/data/journey";
import type { OrchOptions, OrchResult } from "./orchestrator";
import { startOwnedOrchestration } from "./ownedRuns";
import { isMultiAskDump } from "./parse";
import { isNewProjectGoal, namedTeam, parseDelivery } from "./buildChain";
export { orchestrate } from "./orchestrator";

export interface OrchReply {
  text: string;
  /** Journey node the reply points at -- the UI renders a fly-to action. */
  refId?: string;
}

function branchLabel(areaId: string): string {
  return buildGraph().byId.get(areaId)?.label ?? areaId;
}

function counts(milestones: JourneyMilestone[]) {
  const byArea = new Map<string, { done: number; total: number; active: number }>();
  for (const m of milestones) {
    const c = byArea.get(m.areaId) ?? { done: 0, total: 0, active: 0 };
    c.total += 1;
    if (m.status === "done") c.done += 1;
    if (m.status === "active") c.active += 1;
    byArea.set(m.areaId, c);
  }
  return byArea;
}

function nextLine(m: JourneyMilestone | null): { text: string; refId?: string } {
  if (!m) return { text: "Nothing queued -- dump an idea (D) and I'll file it." };
  return {
    text: `Next up: "${m.label}" on ${branchLabel(m.areaId)}${m.eta ? ` -- ${m.eta}` : ""}.`,
    refId: m.id,
  };
}

function statusReply(milestones: JourneyMilestone[]): OrchReply {
  const byArea = counts(milestones);
  const parts: string[] = [];
  for (const [areaId, c] of byArea) {
    parts.push(`${branchLabel(areaId)} ${c.done}/${c.total}${c.active ? " ·plan active·" : ""}`);
  }
  const n = nextUp(milestones);
  return {
    text: `${parts.join("  ·  ")}. ${nextLine(n).text}`,
    refId: n?.id,
  };
}

function branchReply(milestones: JourneyMilestone[], areaId: string): OrchReply {
  const branch = milestones
    .filter((m) => m.areaId === areaId)
    .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.order - b.order);
  if (!branch.length) return { text: `Nothing on ${branchLabel(areaId)} yet.` };
  const done = branch.filter((m) => m.status === "done").length;
  const active = branch.find((m) => m.status === "active");
  const next = branch.find((m) => m.status === "next") ?? branch.find((m) => m.status === "later");
  const bits = [`${branchLabel(areaId)}: ${done}/${branch.length} done`];
  if (active) bits.push(`"${active.label}" is marked active in the roadmap`);
  if (next) bits.push(`then "${next.label}"${next.eta ? ` (${next.eta})` : ""}`);
  return { text: `${bits.join(" -- ")}.`, refId: (next ?? active)?.id };
}

function doneReply(milestones: JourneyMilestone[]): OrchReply {
  const ordered = storyOrder(milestones);
  const byId = new Map(milestones.map((m) => [m.id, m]));
  const done = ordered.map((id) => byId.get(id)!).filter((m) => m.status === "done");
  if (!done.length) return { text: "Nothing shipped yet -- the river starts tonight." };
  const recent = done.slice(-3).reverse();
  return {
    text: `Shipped ${done.length} so far. Most recent: ${recent.map((m) => `"${m.label}"`).join(", ")}.`,
    refId: recent[0].id,
  };
}

const BRANCH_RE = /\b(catalyzed|praxis|studio|finance|ventures|learnai|freelance|business|trading|bot|learn|social)\b/i;
/** Friendly aliases → canonical cluster id (so old/short names still route). */
const BRANCH_ALIAS: Record<string, string> = { social: "studio", bot: "finance", trading: "finance", learn: "learnai", freelance: "ventures", business: "ventures" };

/** Deterministic question → answer over the live journey model. */
export function respond(milestones: JourneyMilestone[], q: string): OrchReply {
  const query = q.toLowerCase();

  const matched = query.match(BRANCH_RE)?.[1]?.toLowerCase();
  if (matched) return branchReply(milestones, BRANCH_ALIAS[matched] ?? matched);

  if (/\b(done|finished|shipped|completed|behind)\b/.test(query)) return doneReply(milestones);

  if (/\b(status|progress|how far|how close|where are we|overview|summary)\b/.test(query))
    return statusReply(milestones);

  if (/\b(next|now what|what now|priorit|focus|ahead|upcoming|then)\b/.test(query)) {
    const n = nextLine(nextUp(milestones));
    return { text: `${n.text} Press J to see it on the corridor.`, refId: n.refId };
  }

  if (/\b(hi|hello|hey|yo)\b/.test(query)) return { text: greeting(milestones) };

  // honest fallback -- this is the phase-1 mock, say what it can do
  const n = nextUp(milestones);
  return {
    text: `I'm the Phase-1 planner -- I read the journey, no model calls. Try "what's next", "status", or a lane name. ${nextLine(n).text}`,
    refId: n?.id,
  };
}

/** Opening line for the docked panel -- computed from the same model. */
export function greeting(milestones: JourneyMilestone[]): string {
  const byArea = counts(milestones);
  let plannedActive = 0;
  for (const c of byArea.values()) plannedActive += c.active;
  const n = nextUp(milestones);
  return `${byArea.size} roadmap lanes, ${plannedActive} milestones marked active in the plan. ${n ? `Next up: "${n.label}" on ${branchLabel(n.areaId)}.` : ""} Ask me "what's next" -- or press D and dump an idea.`;
}

// ── Phase-3: build-intent bridge ─────────────────────────────────────────────

/**
 * Build-intent keywords -- phrases that signal the user wants Praxis to DO
 * something rather than just report on the journey model.
 */
const BUILD_RE =
  /\b(build|create|make|add|implement|write|generate|scaffold|ship|fix|refactor|update|deploy|run|execute|start)\b/i;

/** True when the query is build-intent ("build X", "fix Y") - routed to the orchestrator, not chat. */
export function isBuildIntent(query: string): boolean {
  return BUILD_RE.test(query);
}

/**
 * `tryOrchestrate` -- detects whether a query is actionable ("build X") vs a
 * passive status question. Returns an OrchResult promise when build-intent is
 * detected, or null when the query should fall through to the canned `respond`.
 *
 * Usage:
 *   const orch = tryOrchestrate(query);
 *   if (orch) { const result = await orch; ... } else { respond(milestones, query); }
 */
export function tryOrchestrate(query: string, opts?: OrchOptions): Promise<OrchResult> | null {
  // A BRAIN DUMP fans out into one run per ask. Both voice lanes (the brain mic's route.ts and
  // Atlas's escalate in hybridRouter.ts) reach orchestration through this function, and it used
  // to hand the whole paragraph to ONE run - so four spoken asks became a single confused goal.
  // Checked before BUILD_RE because a dump is mostly complaints ("the usage limits are random"),
  // which BUILD_RE's imperative verbs would never recognise. A named team or a
  // create-then-deliver request is ONE job however many sentences Atlas phrases it in - fanning
  // it out would hand "then open it and maximize it" to a coding agent that has no idea what
  // "it" is.
  const intent = opts?.intent?.trim() || query;
  const oneJob = namedTeam(intent).length >= 2 || (isNewProjectGoal(intent) && parseDelivery(intent) !== null);
  const dump = !oneJob && isMultiAskDump(intent);
  if (!dump && !BUILD_RE.test(intent) && !BUILD_RE.test(query)) return null;
  const run = (runOpts: OrchOptions | undefined): Promise<OrchResult> =>
    // Lazy import so the orchestrator (+ Tauri invoke) is never loaded in tests
    // or headless environments that only use the mock path.
    import("./orchestrator").then(async ({ orchestrate, dispatchBrainDump, brainDumpAsOrchResult }) => {
      if (dump) {
        // Each task picks its OWN folder and rail; a caller-level cwd or tool
        // would force every ask onto one repo and one agent.
        const { cwd: _cwd, preferredTool: _tool, native: _native, ...dumpOpts } = runOpts ?? {};
        return brainDumpAsOrchResult(await dispatchBrainDump(intent, dumpOpts));
      }
      const result = await orchestrate(query, runOpts);
      // Skill-capture loop: when a run finishes GENUINELY DONE (and at least one
      // step succeeded), distil it into a named, reusable skill so "run my <name>"
      // can replay it later. captureSkillFromRun is fully guarded - it no-ops in a
      // browser, on ineligible runs, or on any save failure - so it never affects
      // the result we return to the caller.
      void import("./skills").then(({ captureSkillFromRun }) =>
        captureSkillFromRun(query, result).catch(() => {}),
      );
      return result;
    });
  // Register before the lazy import starts. Direct Background callers use this
  // entry point too, so relying only on orchestrate() would leave a module-load
  // window in which a scoped stop could falsely report terminal.
  if (opts?.ownerToken && !opts.ownerRunRegistered) {
    return startOwnedOrchestration(opts.ownerToken, opts.signal, (signal) =>
      run({ ...opts, signal, ownerRunRegistered: true }),
    );
  }
  return run(opts);
}
