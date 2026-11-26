/**
 * boardContributors.ts - the multi-agent upgrade to the 6am board meeting (the owner-approved
 * 2026-07-05): instead of ONE brain call summarizing the whole fleet off raw ledger data,
 * every fleet agent now contributes its OWN section, generated via its OWN provider/model,
 * and the Praxis brain (boardMeeting.ts) synthesizes those contributions into the final
 * 5-section digest. Every model-backed contribution uses the selected, enabled
 * provider; Scribe remains mechanical because its statement is a direct vault count.
 *
 * BACKBONE ONLY per the build brief: no Command Center UI changes here. The existing
 * BoardMeeting card keeps rendering the final digest markdown exactly as before; this
 * module only changes what feeds that digest.
 *
 * Design:
 *   - Every contribution runs through `Promise.allSettled` (see generateContributions) -
 *     one provider being down (Codex not installed, Hermes off, OpenRouter rate-limited)
 *     must never sink the whole meeting. A failed agent contributes exactly one line:
 *     "⚠ <agent>: unavailable (<reason>)".
 *   - Each contribution is capped at 6 bullets - mirrors boardMeeting.ts's own bullet-cap
 *     philosophy (never trust a model to self-limit; enforceBulletCap re-used here).
 */

import type { AgentRow } from "@/shared/agents";
import type { BoardInputs, BoardRun } from "./boardMeeting";
import { getFleetSelection, type FleetModelOption } from "@/command/fleetStore";
import { enforceBulletCap } from "./boardMeeting";
import { isToolEnabled, isHermesEnabled, liveAvailability } from "./policy";
import type { DriverTool } from "./drivers";

// ── Wire shapes ───────────────────────────────────────────────────────────────

export interface AgentContribution {
  /** Fleet key - mirrors fleetStore's FLEET_AGENTS keys ("forge", "vega", …). */
  key: string;
  /** Display name (matches the roster/fleet codename). */
  name: string;
  /** Which provider actually produced this contribution - surfaced in the vault
   *  spend genuinely spread across pools rather than trusting it blindly. */
  provider: string;
  /** ≤6 bullet lines, already capped. Never empty - a failure still yields one
   *  "⚠ unavailable" line rather than nothing. */
  bullets: string[];
  /** False when this contribution is the "⚠ unavailable" fallback. */
  ok: boolean;
}

const MAX_BULLETS_PER_AGENT = 6;

/**
 * One agent's daily job result (agent_jobs.rs). Now each agent does a real job right before the
 * meeting and its row reports that work, with the file it wrote as evidence.
 */
export interface AgentJobResult {
  agent: string;
  job: string;
  ts: number;
  ok: boolean;
  bullets: string[];
  artifact: string | null;
  recent_steps: number;
  secs: number;
}

function jobFor(jobs: AgentJobResult[] | undefined, key: string): AgentJobResult | undefined {
  return jobs?.find((j) => j.agent === key);
}

/** A job's facts as board bullets, with its evidence file named last. */
export function jobBullets(job: AgentJobResult, max: number = MAX_BULLETS_PER_AGENT): string[] {
  const facts = job.bullets.filter((b) => b.trim()).slice(0, job.artifact ? max - 1 : max);
  if (job.artifact) facts.push(`Evidence: ${job.artifact}`);
  return facts.length ? facts : ["Nothing to report today."];
}

/**
 * Seconds a board contribution may wait on a CLI brain.
 *
 * NOT the interactive 55s. Nobody is watching a board meeting render, so trading latency for a
 * complete board is the right way round.
 */
const BOARD_CLI_TIMEOUT_SECS = 240;

// ── Tauri helpers (mirrors boardMeeting.ts's guarded invoke - never throw) ───

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

// ── Shared persona framing (adapted from agentChat.ts's personaSystemContext -
//    same "merge live state with the ask" philosophy, framed for board reporting
//    instead of a chat reply) ───────────────────────────────────────────────────

/** Static role text per agent - mirrors fleetStore.ts's FLEET_AGENTS `role` field
 *  (kept here as a small local copy since fleetStore's roles are UI-facing labels
 *  and this needs the same string for the prompt without importing the whole
 *  React-hook-oriented module surface). */
const AGENT_ROLE: Record<string, string> = {
  forge: "Claude builder — heavy build/architecture",
  vega: "OpenAI Codex — terminal automation, scaffolding",
  quill: "Cursor editor — focused implementation and review",
  sage: "Research",
  lens: "QA eyes — visual inspection",
  atlas: "Live CU operator + organization sweep owner",
  scribe: "Vault compiler — summarize/link passes",
  ledger: "Run record — %LOCALAPPDATA%\\Praxis\\runs.jsonl",
  relay: "Handoff router — live in-session events, no persisted board record",
  hermes: "Planning brain — hermes oneshot CLI + Command Center planning toggle",
};

/** Find this agent's live roster row (for focus/lane/status), if any. Falls back
 *  to a minimal synthetic row when the agent isn't a Flight Deck session (Sage,
 *  Lens, Atlas, Scribe don't run as fd_sessions rows today) so every contributor
 *  still gets a coherent persona frame. */
function rosterRowFor(key: string, name: string, agents: AgentRow[]): AgentRow {
  const found = agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (found) return found;
  return {
    id: `a.${key}`,
    name,
    model: null,
    family: null,
    status: "idle",
    role: AGENT_ROLE[key] ?? "fleet agent",
    task: null,
    thought: null,
    lane: null,
    touches: [],
    live: false,
    prog: 0,
    progKnown: false,
    focus: null,
  };
}

/** Build the "reporting to the board" persona frame - same merge philosophy as
 *  agentChat.ts's personaSystemContext (identity + Praxis's live briefing on this
 *  agent), adapted so the agent writes a board statement instead of a chat reply. */
function boardPersonaPreamble(key: string, agent: AgentRow): string {
  return [
    `You are ${agent.name}, a named agent in Zach's Praxis fleet — role: ${AGENT_ROLE[key] ?? agent.role}.`,
    `Status: ${agent.status}. Lane: ${agent.lane ?? "none"}. Current focus: ${agent.focus ?? agent.task ?? "nothing in particular right now"}.`,
    "You are reporting to the daily Praxis board meeting — a short first-person statement",
    `of what YOU did/are doing, written as ${agent.name} to the rest of the fleet + Zach.`,
    `HARD FORMAT RULE: at most ${MAX_BULLETS_PER_AGENT} bullet points, no preamble, no sign-off,`,
    "one line per bullet. Report what HAPPENED, from the facts below — never your availability,",
    "readiness, standing or what you could do next. If you genuinely have nothing to report,",
    'write exactly one bullet saying so (e.g. "- Nothing to report today").',
  ].join("\n");
}

// ── Bullet-cap + fallback helpers ────────────────────────────────────────────

function capBullets(text: string, max: number = MAX_BULLETS_PER_AGENT): string[] {
  const capped = enforceBulletCap(text, max);
  const lines = capped
    .split("\n")
    .filter((l) => /^\s*([-*•])\s+/.test(l))
    .map((l) => l.replace(/^\s*([-*•])\s+/, "").trim())
    .filter(Boolean);
  return lines.length ? lines : ["Nothing to report today."];
}

function unavailable(name: string, reason: string): string[] {
  // A reason worth printing is worth printing whole.
  return [`⚠ ${name}: unavailable (${reason.trim().slice(0, 400)})`];
}

/**
 * A missing CLI is a ROUTING problem, not a mute agent.
 *
 * A board where most of the fleet says nothing is not a board - and every one of those agents
 * had a perfectly good rail available, just not its PREFERRED one.
 *
 * The naming is not decoration: an undisclosed fallback would have the owner reading a NIM statement
 * believing it came from the agent's own model, which is the same defect as an undisclosed paid
 * fallback (see brain_without_credit in hermes_bridge.rs). Only when every rail refuses does the
 * agent report unavailable - and then the reason is real.
 */
const BOARD_FALLBACK_RAILS: { provider: string; model?: string; label: string }[] = [
  { provider: "nvidia", model: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "free NVIDIA" },
  { provider: "openai-codex", label: "the ChatGPT subscription" },
];

async function contributeViaFallback(
  key: string,
  name: string,
  extra: string,
  agent: AgentRow,
  preferredError: string,
): Promise<AgentContribution> {
  if (!inTauri()) {
    return { key, name, provider: "unavailable", bullets: unavailable(name, preferredError), ok: false };
  }
  const message = [boardPersonaPreamble(key, agent), "", extra, "", "Write your board statement now."].join("\n");
  const tried: string[] = [];
  for (const rail of BOARD_FALLBACK_RAILS) {
    try {
      const reply = await tauriInvoke<string>("brain_chat", {
        message,
        context: `Board-meeting contribution for ${name} (system task, not a user chat turn).`,
        model: rail.model,
        provider: rail.provider,
        timeoutSecs: BOARD_CLI_TIMEOUT_SECS,
      });
      const bullets = capBullets(reply);
      // The provenance line leads, so it is read before the content it qualifies.
      bullets.unshift(`(${name}'s own rail was unavailable - answered on ${rail.label}.)`);
      return { key, name, provider: rail.provider, bullets, ok: true };
    } catch (err) {
      tried.push(rail.label);
    }
  }
  return {
    key,
    name,
    provider: "unavailable",
    bullets: unavailable(name, `${preferredError}; fallbacks also failed (${tried.join(", ")})`),
    ok: false,
  };
}

// ── Per-agent generators ─────────────────────────────────────────────────────

/** Summarize a run list into a plain-text block for a prompt (mirrors boardMeeting.ts's
 *  runsBlock construction, reused per-agent instead of fleet-wide). */
function runsBlock(runs: BoardRun[]): string {
  if (!runs.length) return "(no delegations recorded)";
  return runs
    .map((r) => `- [${r.done ? "done" : "incomplete"}] ${r.goal} (${r.ok_steps}/${r.total_steps} steps ok)`)
    .join("\n");
}

/** Forge - summarizes its OWN delegations (runs.jsonl entries tagged tool "claude") via
 *  prompted AS Forge reporting to the board. */
const NATIVE_BILLING_FOR_TOOL: Record<DriverTool, FleetModelOption["billing"]> = {
  claude: "claude-max",
  codex: "chatgpt",
  cursor: "cursor-sub",
};

async function delegateContribution(
  key: string,
  name: string,
  tool: DriverTool,
  extra: string,
  agent: AgentRow,
): Promise<AgentContribution> {
  const selection = getFleetSelection(key);
  if (!selection || selection.billing !== NATIVE_BILLING_FOR_TOOL[tool]) {
    return contributeViaFallback(key, name, extra, agent, "selected rail has no native executor");
  }
  if (!isToolEnabled(tool)) {
    // A breaker the owner CUT is a deliberate choice, so it is reported, never routed around.
    return { key, name, provider: tool, bullets: unavailable(name, `${tool} breaker open`), ok: false };
  }
  if (!inTauri()) return { key, name, provider: tool, bullets: unavailable(name, "not in Tauri runtime"), ok: false };

  try {
    const prompt = [boardPersonaPreamble(key, agent), "", extra, "", "Write your board statement now."].join("\n");
    const reply = await tauriInvoke<string>("agent_delegate", {
      tool,
      prompt,
      model: selection.id || undefined,
    });
    return { key, name, provider: tool, bullets: capBullets(reply), ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return contributeViaFallback(key, name, extra, agent, msg);
  }
}

/**
 * Why a builder CAN'T work right now, or null when it can.
 *
 * Checked before the run-ledger fact. "Did nothing" and "could not do anything" are different
 * reports. This is the same check the mission planner benches on (policy.toolAvailability:
 * breaker, remembered failure, refused/out-of-usage rail).
 */
async function builderBlocked(tool: DriverTool): Promise<string | null> {
  if (!isToolEnabled(tool)) {
    const label = tool === "claude" ? "Claude" : tool === "codex" ? "Codex" : "Cursor";
    return `breaker open - ${label} is switched off in Command Center → Tool switches, so it took no work`;
  }
  try {
    const avail = (await liveAvailability())[tool];
    if (avail && !avail.usable) return avail.reason ?? `${tool} is unavailable`;
  } catch {
    /* probe failed - say nothing rather than guess */
  }
  return null;
}

/**
 * A builder's row. A builder that can't work says why first. With no build steps in the
 * last 24h the row is the plain fact (its last real step and date) - no model call, so no
 * quota spent writing "I'm available". With steps, the agent speaks for itself on its own
 * model, from those facts only.
 */
async function builderContribution(
  key: string,
  name: string,
  tool: DriverTool,
  job: AgentJobResult | undefined,
  fallbackExtra: string,
  agent: AgentRow,
): Promise<AgentContribution> {
  const blocked = await builderBlocked(tool);
  if (blocked) {
    const facts = job ? jobBullets(job, MAX_BULLETS_PER_AGENT - 1) : [];
    return { key, name, provider: "availability", bullets: [`⚠ ${name} can't work: ${blocked}`, ...facts], ok: false };
  }
  if (job && job.recent_steps === 0) {
    return { key, name, provider: "run ledger", bullets: jobBullets(job), ok: true };
  }
  const extra = job
    ? `Your real build steps in the last 24h (from Praxis's run ledger — report ONLY these facts, first person):\n${job.bullets.map((b) => `- ${b}`).join("\n")}`
    : fallbackExtra;
  return delegateContribution(key, name, tool, extra, agent);
}

async function forgeContribution(inputs: BoardInputs, agent: AgentRow, job?: AgentJobResult): Promise<AgentContribution> {
  return builderContribution(
    "forge",
    "Forge",
    "claude",
    job,
    `Your recent build delegations (from the run ledger, tool="claude"):\n${runsBlock(inputs.forge_runs)}`,
    agent,
  );
}

/** Vega - summarizes its OWN Codex runs (tool "codex") via `agent_delegate("codex", …)`,
 * Falls back cleanly with the standard unavailable line when the codex CLI isn't
 * installed/reachable - the
 *  same failure `run_codex` in hermes_bridge.rs already reports. */
async function vegaContribution(inputs: BoardInputs, agent: AgentRow, job?: AgentJobResult): Promise<AgentContribution> {
  return builderContribution(
    "vega",
    "Vega",
    "codex",
    job,
    `Your recent delegations (from the run ledger, tool="codex"):\n${runsBlock(inputs.vega_runs)}`,
    agent,
  );
}

/** Generic brain_chat contribution for agents with no dedicated CLI delegation path
 *  Missing, disabled, unknown, and cursor-sub routes fail closed without a call. */
const PROVIDER_FOR_BILLING: Partial<Record<FleetModelOption["billing"], string>> = {
  "openai-api": "openai-api",
  openrouter: "openrouter",
  nvidia: "nvidia",
  chatgpt: "openai-codex",
  "claude-max": "claude-max",
};

const BREAKER_FOR_BILLING: Partial<Record<FleetModelOption["billing"], string>> = {
  openrouter: "openrouter",
  chatgpt: "codex",
  "claude-max": "claude",
  "cursor-sub": "cursor",
};

export function boardRouteForSelection(
  selection: FleetModelOption | null,
): { provider: string; model?: string; error?: string } {
  if (!selection) return { provider: "unavailable", error: "no fleet selection" };
  if (selection.billing === "cursor-sub") {
    return { provider: "cursor", error: "cursor subscription has no board-chat seam" };
  }
  const breaker = BREAKER_FOR_BILLING[selection.billing];
  if (breaker && !isToolEnabled(breaker)) {
    return { provider: PROVIDER_FOR_BILLING[selection.billing] ?? "unavailable", error: `${breaker} breaker open` };
  }
  const provider = PROVIDER_FOR_BILLING[selection.billing];
  if (!provider) return { provider: "unavailable", error: "unsupported fleet billing source" };
  return {
    provider,
    model: provider === "openai-codex" ? undefined : selection.id || undefined,
  };
}

async function brainChatContribution(
  key: string,
  name: string,
  extra: string,
  agent: AgentRow
): Promise<AgentContribution> {
  const selection = getFleetSelection(key);
  const route = boardRouteForSelection(selection);
  if (route.error) {
    // A cut breaker stays reported; anything else (no seam, missing CLI) gets rerouted.
    if (/breaker open/i.test(route.error)) {
      return { key, name, provider: route.provider, bullets: unavailable(name, route.error), ok: false };
    }
    return contributeViaFallback(key, name, extra, agent, route.error);
  }
  if (!inTauri()) return { key, name, provider: route.provider, bullets: unavailable(name, "not in Tauri runtime"), ok: false };
  try {
    const message = [boardPersonaPreamble(key, agent), "", extra, "", "Write your board statement now."].join("\n");
    const reply = await tauriInvoke<string>("brain_chat", {
      message,
      context: `Board-meeting contribution for ${name} (system task, not a user chat turn).`,
      model: route.model,
      provider: route.provider,
      timeoutSecs: BOARD_CLI_TIMEOUT_SECS,
    });
    return { key, name, provider: route.provider, bullets: capBullets(reply), ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return contributeViaFallback(key, name, extra, agent, msg);
  }
}

/** Quill used to be asked only for its "standing and what you are ready to work on" -
 *  which is exactly how the board came to say "Standing is available". Now it reports its
 *  real Cursor steps like every other builder. */
async function quillContribution(agent: AgentRow, job?: AgentJobResult): Promise<AgentContribution> {
  if (inTauri()) {
    try {
      const pool = await tauriInvoke<{ note: string }>("cursor_pool_state", {});
      if (pool?.note && job) {
        const paused = pool.note.replace(/^Quill sat this one out: /, "Paused: ");
        return { key: "quill", name: "Quill", provider: "run ledger", bullets: [paused, ...jobBullets(job, MAX_BULLETS_PER_AGENT - 1)], ok: true };
      }
    } catch {
      /* pool unreadable: report the steps as usual */
    }
  }
  return builderContribution(
    "quill",
    "Quill",
    "cursor",
    job,
    "No run-ledger facts were available this morning. Say so in one bullet; do not describe your availability or fabricate work.",
    agent,
  );
}

/** Sage additionally folds in research-inbox.md items - the parallel research-agent
 *  ideas file (may not exist yet; read defensively, same as boardMeeting.ts's own
 *  fleet-wide handling of this source). */
function sageContribution(inputs: BoardInputs, agent: AgentRow): Promise<AgentContribution> {
  const researchBlock = inputs.research_inbox_present
    ? inputs.research_inbox.trim() || "(research-inbox.md exists but is empty)"
    : "(research-inbox.md not present yet — skip this source, do not invent ideas)";
  return brainChatContribution(
    "sage",
    "Sage",
    `Research inbox (your own ideas file, read directly — cite specific items):\n${researchBlock}`,
    agent
  );
}

/** Atlas folds in the latest org-report (its own organization-sweep output from
 *  org_scan.rs) - read directly rather than re-summarized, so Atlas cites its own
 *  real findings. */
function atlasContribution(inputs: BoardInputs, agent: AgentRow): Promise<AgentContribution> {
  const reportBlock = inputs.latest_org_report.trim()
    ? `Your latest organization sweep (${inputs.latest_org_report_file}):\n${inputs.latest_org_report.trim()}`
    : "(no organization-sweep report exists yet — you haven't run one, or none has been generated)";
  return brainChatContribution("atlas", "Atlas", reportBlock, agent);
}

function lensContribution(agent: AgentRow, job?: AgentJobResult): Promise<AgentContribution> {
  // Lens's daily QA pass (agent_jobs.rs) is the statement: what it rendered, what it found,
  // and the report it wrote. Only if that job could not run does Lens fall back to a model.
  if (job) {
    return Promise.resolve({ key: "lens", name: "Lens", provider: "QA pass", bullets: jobBullets(job), ok: job.ok });
  }
  return brainChatContribution(
    "lens",
    "Lens",
    "Report on your QA/visual-inspection standing — recent passes if you know of any, otherwise " +
      "state plainly that no QA passes are tracked for you to report on.",
    agent
  );
}

/** Scribe reports mechanically from one graph snapshot - the hygiene job when
 *  available, otherwise inputs.vault_stats from board_meeting.rs. No LLM call. */
export async function scribeContribution(inputs: BoardInputs, job?: AgentJobResult): Promise<AgentContribution> {
  const key = "scribe";
  const name = "Scribe";
  const s = inputs.vault_stats;
  // The Memory Galaxy hygiene pass (agent_jobs.rs) is Scribe's real work: orphan trend,
  // concrete link suggestions, and the report it wrote. Counts alone were just a census.
  if (job && job.ok) {
    // The job carries its own census from the SAME graph read as its orphan counts.
    // vault_stats may have been gathered before a graph rebuild; never mix snapshots.
    return { key, name, provider: "galaxy hygiene", bullets: jobBullets(job), ok: true };
  }
  if (!s.present) {
    return {
      key,
      name,
      provider: "mechanical",
      bullets: ["Vault graph hasn't been built yet — open the Memory Galaxy once to generate it."],
      ok: true,
    };
  }
  const topAreas = s.nodes_by_area
    .slice(0, 3)
    .map(([area, n]) => `${area} (${n})`)
    .join(", ");
  const topKinds = s.nodes_by_kind
    .slice(0, 3)
    .map(([kind, n]) => `${kind} (${n})`)
    .join(", ");
  const notes = s.nodes_by_kind.reduce((sum, [, n]) => sum + n, 0);
  const bullets = [
    `${s.total_nodes} nodes (${notes} notes + ${s.total_nodes - notes} area hubs), ${s.total_edges} edges in the vault graph. Orphan counts exclude hubs.`,
    topAreas ? `Top areas by node count: ${topAreas}.` : "No area breakdown available.",
    topKinds ? `Top node kinds: ${topKinds}.` : "No kind breakdown available.",
    `${s.orphan_count} of ${notes} notes are orphans (degree 0 — no real links).`,
  ];
  return { key, name, provider: "mechanical", bullets, ok: true };
}

/** Calendar date of a unix-ms timestamp in the local timezone - never a relative "yesterday". */
export function ledgerDate(ts: number): string {
  if (!(ts > 0)) return "an unknown date";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "an unknown date";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Ledger - DETERMINISTIC, no LLM. Owns `%LOCALAPPDATA%\Praxis\runs.jsonl`.
 * Windowed counts only; a fallback historical run is named as old, never as recent.
 */
export function ledgerContribution(inputs: BoardInputs): AgentContribution {
  const key = "ledger";
  const name = "Ledger";
  const total = inputs.total_runs_in_ledger;
  const ageDays = inputs.recent_runs_age_days ?? null;
  const newest = inputs.recent_runs[0];

  if (!total) {
    return {
      key,
      name,
      provider: "mechanical",
      bullets: ["No runs in the ledger yet."],
      ok: true,
    };
  }

  if (ageDays != null && ageDays > 0) {
    const last = newest ? ledgerDate(newest.ts) : "an unknown date";
    const goal = newest?.goal?.trim() ? newest.goal.trim() : "untitled";
    const outcome = newest ? (newest.done ? "done" : "failed") : "unknown";
    return {
      key,
      name,
      provider: "mechanical",
      bullets: [
        `No runs in the window — last run was ${last}.`,
        `Ledger holds ${total} run${total === 1 ? "" : "s"} total.`,
        `Newest on file (${outcome}): ${goal}.`,
      ],
      ok: true,
    };
  }

  const windowed = inputs.recent_runs;
  const done = windowed.filter((r) => r.done).length;
  const failed = windowed.length - done;
  const newestDate = newest ? ledgerDate(newest.ts) : "an unknown date";
  const newestGoal = newest?.goal?.trim() ? newest.goal.trim() : "untitled";
  const newestOutcome = newest ? (newest.done ? "done" : "failed") : "unknown";
  const bullets = [
    `${windowed.length} run${windowed.length === 1 ? "" : "s"} in the window (${done} done, ${failed} failed).`,
    `Newest (${newestDate}, ${newestOutcome}): ${newestGoal}.`,
    `Ledger holds ${total} run${total === 1 ? "" : "s"} total.`,
  ];
  return { key, name, provider: "mechanical", bullets, ok: true };
}

/**
 * Relay owns live in-session handoff routing (eventBus agent:handoff / journey:handoff).
 * Those packets are not persisted, so a 6am board cannot honestly summarize them.
 */
export function relayContribution(job?: AgentJobResult): AgentContribution {
  // Every handoff Praxis routes is recorded step-by-step in runs.jsonl, so Relay's row is
  // the real handoff log (agent, model, time, outcome) - not "no board seat".
  if (job) {
    return { key: "relay", name: "Relay", provider: "handoff log", bullets: jobBullets(job), ok: true };
  }
  return {
    key: "relay",
    name: "Relay",
    provider: "mechanical",
    bullets: [
      "Relay — no board seat: handoffs are live in-session routing events, not a persisted record this meeting can read.",
    ],
    ok: true,
  };
}

export interface HermesBoardHealth {
  degraded: boolean;
  reason: string;
}

/** Mechanical Hermes statement from the planning toggle + live CLI health. */
export function hermesBullets(planningOn: boolean, health: HermesBoardHealth | null): string[] {
  const bullets: string[] = [
    planningOn
      ? "Hermes planning is ON — orchestrator plan calls run through the oneshot CLI."
      : "Hermes planning is OFF — orchestrator skips the plan call and runs a single direct pass.",
  ];
  if (!health) {
    bullets.push("Planning-brain health could not be read (not in the Tauri runtime, or the health command did not answer).");
    return bullets;
  }
  if (health.degraded) {
    bullets.push(
      health.reason.trim()
        ? `Planning brain is unreachable: ${health.reason.trim()}`
        : "Planning brain is unreachable.",
    );
  } else {
    bullets.push("Planning brain CLI is present.");
  }
  return bullets;
}

async function hermesContribution(job?: AgentJobResult): Promise<AgentContribution> {
  const planningOn = isHermesEnabled();
  let health: HermesBoardHealth | null = null;
  if (inTauri()) {
    try {
      health = await tauriInvoke<HermesBoardHealth>("hermes_health");
    } catch {
      health = null;
    }
  }
  // What the brain engine actually did: the model calls it made in the last 24h, by rail.
  const calls = job ? jobBullets(job, MAX_BULLETS_PER_AGENT - 2) : [];
  return {
    key: "hermes",
    name: "Hermes",
    provider: "mechanical",
    bullets: [...calls, ...hermesBullets(planningOn, health)].slice(0, MAX_BULLETS_PER_AGENT),
    ok: true,
  };
}

// ── The ordered contributor list - the ONE config seam a later Command Center ──
// redesign exposes as per-agent toggles. Order here is also the order contributions
// render in the vault doc's "Agent statements" section. Ten identities: the original
// seven plus Ledger / Relay / Hermes, which the roster lists but this meeting used
// to silently omit.

export const CONTRIBUTOR_KEYS = [
  "forge",
  "vega",
  "quill",
  "sage",
  "lens",
  "atlas",
  "scribe",
  "ledger",
  "relay",
  "hermes",
] as const;

/**
 * Run every contributor's generator in parallel via Promise.allSettled - one
 * provider being down must never sink the meeting. Every settled outcome (even a
 * rejection, which shouldn't happen since each generator already catches its own
 * errors, but is guarded here too as belt-and-suspenders) yields a contribution;
 * order in the returned array always matches CONTRIBUTOR_KEYS.
 */
export async function generateContributions(
  inputs: BoardInputs,
  agents: AgentRow[],
  jobs?: AgentJobResult[],
): Promise<AgentContribution[]> {
  const forgeAgent = rosterRowFor("forge", "Forge", agents);
  const vegaAgent = rosterRowFor("vega", "Vega", agents);
  const quillAgent = rosterRowFor("quill", "Quill", agents);
  const sageAgent = rosterRowFor("sage", "Sage", agents);
  const lensAgent = rosterRowFor("lens", "Lens", agents);
  const atlasAgent = rosterRowFor("atlas", "Atlas", agents);

  const settled = await Promise.allSettled([
    forgeContribution(inputs, forgeAgent, jobFor(jobs, "forge")),
    vegaContribution(inputs, vegaAgent, jobFor(jobs, "vega")),
    quillContribution(quillAgent, jobFor(jobs, "quill")),
    sageContribution(inputs, sageAgent),
    lensContribution(lensAgent, jobFor(jobs, "lens")),
    atlasContribution(inputs, atlasAgent),
    scribeContribution(inputs, jobFor(jobs, "scribe")),
    Promise.resolve(ledgerContribution(inputs)),
    Promise.resolve(relayContribution(jobFor(jobs, "relay"))),
    hermesContribution(jobFor(jobs, "hermes")),
  ]);

  return settled.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    const key = CONTRIBUTOR_KEYS[i];
    const name = key.charAt(0).toUpperCase() + key.slice(1);
    const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return { key, name, provider: "unknown", bullets: unavailable(name, msg), ok: false };
  });
}

/** Render contributions as the vault doc's "## Agent statements" section - the raw
 *  per-agent bullets, so the owner can read who said what, distinct from the synthesized
 *  top digest. */
export function renderAgentStatements(contributions: AgentContribution[]): string {
  return contributions
    .map((c) => {
      const providerNote = c.ok ? ` _(via ${c.provider})_` : "";
      return `### ${c.name}${providerNote}\n${c.bullets.map((b) => `- ${b}`).join("\n")}`;
    })
    .join("\n\n");
}

/** Render contributions as a compact block for the brain's synthesis prompt - the
 *  brain reads what every agent said and produces the final 5-section digest from
 *  THIS (agent statements), not raw ledger data directly. */
export function contributionsForSynthesisPrompt(contributions: AgentContribution[]): string {
  return contributions
    .map((c) => `${c.name} (${c.provider}):\n${c.bullets.map((b) => `- ${b}`).join("\n")}`)
    .join("\n\n");
}
