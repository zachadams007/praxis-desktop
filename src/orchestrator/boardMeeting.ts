/**
 * boardMeeting.ts - the 6am "all agents meet" digest.
 *
 * HARD FORMAT RULE: bullet points, ~1 page MAX (he explicitly rejects 3-5 page reports). Five
 * sections: done yesterday / confirmed completed / in progress now / next-open / needs the owner's
 * input (incl. the research agent's new ideas, read defensively from research-inbox.md - a
 * parallel lane owns that file and it may not exist yet).
 *
 * 2026-07-05 upgrade (the owner-approved): this went from ONE brain call summarizing raw
 * ledger data to a TRUE multi-agent meeting - every fleet agent contributes its OWN
 * section via its OWN provider/model (see boardContributors.ts), and the brain here
 * SYNTHESIZES those contributions into the same 5-section digest, rather than reading
 * raw facts directly. Spend spreads across pools by construction: Forge on Claude Max,
 * Vega on the ChatGPT/Codex sub, Quill/Sage/Lens/Atlas each on their own fleetStore
 * model (OpenRouter/NVIDIA), Scribe mechanical (zero LLM calls). BACKBONE ONLY - no
 * Command Center UI changes; the existing BoardMeeting card still renders the final
 * digest markdown exactly as before.
 *
 * Pipeline (mirrors the run_ledger/run_notes split - gather → contribute → synthesize
 * → persist):
 *   1. GATHER - `board_meeting_gather` (Rust) reads every real source, mechanically
 *                    capped (runs.jsonl [fleet-wide + Forge/Vega's own slices], vault
 *                    run-notes, intent ledger "Open now", usage.json, research-inbox.md,
 *                    latest org-report, vault-graph stats).
 *   2. CONTRIBUTE - `generateContributions` (boardContributors.ts) fans out to every
 *                    fleet agent in parallel (Promise.allSettled - one provider down
 *                    never sinks the meeting), each producing ≤6 bullets in its own voice
 *                    via its own provider.
 *   3. SYNTHESIZE - the brain (brain_chat, same seam Command Center chat uses) reads
 *                    ALL agent statements and produces the 5-section bullet digest. The
 *                    length cap is enforced BOTH by capping the input AND by instructing +
 *                    mechanically re-truncating the output here (never trust a model to
 *                    self-limit - see `enforceBulletCap`).
 *
 * Fully defensive outside Tauri (dev browser): every invoke is guarded, missing sources
 * degrade to empty sections rather than throwing - the digest still "meets" even on a
 * fresh install with zero history.
 */

import { selectedBrain } from "./brain";
import type { AgentRow } from "@/shared/agents";
import {
  generateContributions,
  renderAgentStatements,
  contributionsForSynthesisPrompt,
  type AgentContribution,
  type AgentJobResult,
} from "./boardContributors";

// ── Wire shapes (mirror board_meeting.rs) ────────────────────────────────────

interface BoardRun {
  ts: number;
  goal: string;
  done: boolean;
  tools: string[];
  ok_steps: number;
  total_steps: number;
}

interface VaultStats {
  total_nodes: number;
  total_edges: number;
  nodes_by_area: [string, number][];
  nodes_by_kind: [string, number][];
  orphan_count: number;
  present: boolean;
}

interface BoardInputs {
  recent_runs: BoardRun[];
  /** Whole days since the newest run, when NOTHING fell inside the 24h window. */
  recent_runs_age_days?: number | null;
  total_runs_in_ledger: number;
  recent_run_note_files: string[];
  open_now: string[];
  spend_by_tool: [string, number][];
  models_active: string[];
  research_inbox: string;
  research_inbox_present: boolean;
  forge_runs: BoardRun[];
  vega_runs: BoardRun[];
  latest_org_report: string;
  latest_org_report_file: string;
  vault_stats: VaultStats;
}

export interface BoardMeetingResult {
  date: string;
  digestMarkdown: string;
  path: string;
  hadData: boolean;
}

// ── Tauri helpers (guarded - never throw into the caller) ───────────────────

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** Today's local date as `YYYY-MM-DD` - also the digest's filename + storage key. */
export function todayLocalDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── Mechanical bullet cap (never trust the model to self-limit) ─────────────

const MAX_BULLETS_TOTAL = 40;

/**
 * Enforce the ~1-page rule mechanically: count lines that look like bullets
 * (`- ` / `* ` / `• `) across the whole digest and hard-truncate past the cap,
 * appending a visible marker so a trim is never silent. Section headings and
 * blank lines don't count against the cap.
 */
function enforceBulletCap(markdown: string, maxBullets: number = MAX_BULLETS_TOTAL): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let bulletCount = 0;
  let truncated = false;

  for (const line of lines) {
    const isBullet = /^\s*([-*•])\s+/.test(line);
    if (isBullet) {
      if (bulletCount >= maxBullets) {
        truncated = true;
        continue;
      }
      bulletCount += 1;
    }
    out.push(line);
  }

  if (truncated) {
    out.push("", `_(truncated to ${maxBullets} bullets total — the ~1-page cap)_`);
  }
  return out.join("\n").trim();
}

// ── Prompt construction ───────────────────────────────────────────────────────

const SECTION_TITLES = [
  "What was done yesterday",
  "Confirmed completed",
  "Being worked on now",
  "Next / still open",
  "Needs Zach's input",
] as const;

/**
 * Build the SYNTHESIS prompt - the brain now reads every agent's OWN board statement
 * (produced in boardContributors.ts, each via its own provider) plus the same
 * fleet-wide facts as before (open_now, spend, research inbox) for anything the
 * per-agent statements don't cover, and produces the final 5-section digest. This
 * replaces the old "brain reads raw ledger directly" design - the brain's job is now
 * synthesis of what the fleet already said about itself, not first-pass summarization.
 */
function buildPrompt(inputs: BoardInputs, agents: AgentRow[], contributions: AgentContribution[]): string {
  const statementsBlock = contributionsForSynthesisPrompt(contributions);

  const openNowBlock = inputs.open_now.length ? inputs.open_now.join("\n") : "(intent ledger 'Open now' section empty or unavailable)";

  // NEVER let history be printed under "what was done yesterday".
  // The 24h window being empty is normal on a quiet day, and falling back to real
  // history is right - but on 2026-09-16 that surfaced a 2026-07-02 run as yesterday's
  // confirmed work. If it is old, the digest has to say how old.
  const ageDays = inputs.recent_runs_age_days ?? null;
  const staleRunsWarning =
    ageDays != null && ageDays > 0
      ? `
IMPORTANT: NO runs were recorded in the last 24 hours. The runs below are the most recent in the ledger and are ${ageDays} day(s) old. Do NOT describe them as yesterday's work — say plainly that there were no runs in the last 24h and that the newest is ${ageDays} day(s) old.
`
      : "";

  const spendBlock = inputs.spend_by_tool.length
    ? inputs.spend_by_tool.map(([tool, usd]) => `${tool}: $${usd.toFixed(2)}`).join(", ")
    : "(no spend recorded)";

  const modelsBlock = inputs.models_active.length ? inputs.models_active.join(", ") : "(none recorded)";

  const researchBlock = inputs.research_inbox_present
    ? inputs.research_inbox.trim() || "(research-inbox.md exists but is empty)"
    : "(research-inbox.md not present yet — a parallel lane may still be building it; skip this source, do not invent ideas)";

  const rosterBlock = agents.length
    ? agents.map((a) => `${a.name} (${a.role}): ${a.status}${a.task ? ` — ${a.task}` : ""}`).join("\n")
    : "(no live agent roster available)";

  const failedAgents = contributions.filter((c) => !c.ok).map((c) => c.name);

  return `You are compiling the Praxis "board meeting" — a daily digest ALL Praxis agents produce together so shared state syncs and Zach stays in the loop without micro-orchestrating. Every agent below already wrote its OWN statement about what it did — your job is to SYNTHESIZE those statements (plus the fleet-wide facts) into ONE unified digest, not to re-derive facts from scratch.

HARD FORMAT RULE (non-negotiable): bullet points ONLY, ~1 page MAX, at most ${MAX_BULLETS_TOTAL} bullets across the WHOLE digest. Zach explicitly rejects long reports — be ruthlessly terse. One line per bullet, no sub-bullets, no preamble, no closing summary.

Produce EXACTLY five markdown sections, in this order, each a "## " heading followed by bullets (use "(none)" if a section has nothing real to report — never pad with filler):
${SECTION_TITLES.map((t, i) => `${i + 1}. ## ${t}`).join("\n")}

For section 5 ("Needs Zach's input"), specifically surface: open decisions, ambiguous/unverified items, new ideas from the research inbox below (flagged "[research]"), AND any agent listed as unavailable below (flagged "[unavailable]" — Zach should know a provider was down)${failedAgents.length ? `. Agents unavailable this run: ${failedAgents.join(", ")}` : ""}.

AGENT STATEMENTS (each agent's own report, via its own provider — this is your primary source; do not invent facts beyond what these say):
${statementsBlock}

FLEET-WIDE FACTS (already trimmed — supplement the statements above, don't duplicate them verbatim):
${staleRunsWarning}

Intent ledger "Open now":
${openNowBlock}

Spend by tool: ${spendBlock}
Models active: ${modelsBlock}

Research inbox (a parallel lane's research-agent ideas — read defensively, may be absent):
${researchBlock}

Live agent roster at generation time:
${rosterBlock}

Write the five sections now.`;
}

// ── Fallback digest (brain unavailable - never block on it) ─────────────────

function fallbackDigest(inputs: BoardInputs): string {
  const bullets = (arr: string[], empty: string) => (arr.length ? arr.map((s) => `- ${s}`).join("\n") : `- ${empty}`);

  const doneRuns = inputs.recent_runs.filter((r) => r.done).map((r) => r.goal);
  const inFlightRuns = inputs.recent_runs.filter((r) => !r.done).map((r) => r.goal);

  return [
    `## ${SECTION_TITLES[0]}`,
    ...(inputs.recent_runs_age_days != null && inputs.recent_runs_age_days > 0
      ? [`- NO runs in the last 24h — the items below are ${inputs.recent_runs_age_days} day(s) old.`]
      : []),
    bullets(inputs.recent_runs.map((r) => r.goal), "no runs recorded"),
    "",
    `## ${SECTION_TITLES[1]}`,
    bullets(doneRuns, "nothing confirmed done in this window"),
    "",
    `## ${SECTION_TITLES[2]}`,
    bullets(inFlightRuns, "nothing in flight"),
    "",
    `## ${SECTION_TITLES[3]}`,
    bullets(inputs.open_now.slice(0, 10), "intent ledger has no open items"),
    "",
    `## ${SECTION_TITLES[4]}`,
    inputs.research_inbox_present && inputs.research_inbox.trim()
      ? `- [research] see research-inbox.md — brain compression was unavailable, review it directly`
      : "- (brain unavailable — this is a mechanical fallback digest, review the raw ledger)",
  ].join("\n");
}

// ── Agent-statements footer (raw contributions - distinct from the synthesized top) ──

function agentStatementsSection(contributions: AgentContribution[]): string {
  return `## Agent statements\n\n${renderAgentStatements(contributions)}`;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Generate today's board meeting digest: gather → per-agent contribute → brain-
 * synthesize → persist + notify. Idempotent-ish by the caller's discretion (the
 * scheduler checks board_meeting_exists_today first) - this function itself always
 * regenerates when called, so it also doubles as a manual "regenerate today's digest"
 * action from the Command Center card.
 */
export async function generateBoardMeeting(agents: AgentRow[]): Promise<BoardMeetingResult | null> {
  if (!inTauri()) return null;

  let inputs: BoardInputs;
  try {
    inputs = await tauriInvoke<BoardInputs>("board_meeting_gather");
  } catch {
    return null; // gather is local-only I/O - a failure here means the command is missing
  }

  // Every agent does its daily job FIRST (agent_jobs.rs: Lens QAs the latest delivered
  // build, Scribe audits the Memory Galaxy, Relay/Hermes/builders read what really
  // happened), so the board reports work with evidence instead of "available". Local and
  // free; a failure here only means those rows fall back to their older statements.
  let jobs: AgentJobResult[] = [];
  try {
    jobs = await tauriInvoke<AgentJobResult[]>("agent_jobs_run_daily");
  } catch {
    jobs = [];
  }

  // Fan out to every fleet agent in parallel - one provider being down (Codex not
  // installed, Hermes off, OpenRouter rate-limited) never sinks the whole meeting;
  // generateContributions already guards every generator individually and via
  // Promise.allSettled, so this call itself cannot throw.
  const contributions = await generateContributions(inputs, agents, jobs);

  const hadData =
    inputs.recent_runs.length > 0 ||
    inputs.open_now.length > 0 ||
    inputs.recent_run_note_files.length > 0 ||
    (inputs.research_inbox_present && inputs.research_inbox.trim().length > 0) ||
    contributions.some((c) => c.ok);

  let digestMarkdown: string;
  try {
    const { provider, model, fallbacks } = selectedBrain();
    const prompt = buildPrompt(inputs, agents, contributions);
    const reply = await tauriInvoke<string>("brain_chat", {
      message: prompt,
      context: "Generating the daily board-meeting digest (system task, not a user chat turn).",
      model,
      provider,
      fallbacks,
    });
    digestMarkdown = enforceBulletCap(reply);
  } catch {
    // Brain unavailable (Hermes down / provider error / dev browser) - still produce a
    // useful mechanical digest rather than nothing at all.
    digestMarkdown = enforceBulletCap(fallbackDigest(inputs));
  }

  // Append the raw per-agent statements UNDER the synthesized digest, and UNDER the
  // bullet cap (the cap only governs the top synthesized section - the owner explicitly
  // wants to be able to read who said what, so this section is never truncated by
  // MAX_BULLETS_TOTAL, only by each contribution's own ≤6-bullet cap upstream).
  const fullMarkdown = `${digestMarkdown}\n\n${agentStatementsSection(contributions)}`;

  const date = todayLocalDate();
  const ts = Date.now();

  let path = "";
  try {
    path = await tauriInvoke<string>("board_meeting_write", {
      entry: {
        digest_markdown: fullMarkdown,
        date,
        ts,
        agents: agents.map((a) => ({
          name: a.name,
          role: a.role,
          status: a.status,
          task: a.task ?? null,
        })),
        had_data: hadData,
      },
    });
  } catch {
    return null; // persistence failed - don't claim success or notify
  }

  try {
    await tauriInvoke("board_meeting_notify", { date });
  } catch {
    /* notification best-effort - the digest itself already landed */
  }

  return { date, digestMarkdown: fullMarkdown, path, hadData };
}

/** Read-only check used by the scheduler for catch-up-on-start logic. */
export async function boardMeetingExistsToday(date: string = todayLocalDate()): Promise<boolean> {
  if (!inTauri()) return false;
  try {
    return await tauriInvoke<boolean>("board_meeting_exists_today", { date });
  } catch {
    return false;
  }
}

export { enforceBulletCap, buildPrompt, fallbackDigest };
export type { BoardInputs, BoardRun };
