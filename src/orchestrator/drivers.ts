/**
 * Driver agents - thin wrappers that delegate work to claude/codex/cursor via
 * the Rust `agent_delegate` Tauri command (hermes_bridge.rs).
 *
 * Each driver carries the CANONICAL fleet agent id from data/graph.ts AGENTS
 * (a.forge = Claude Code, a.vega = Codex, a.quill = Cursor). This matters: the
 * store (usePraxisStore.applyEvent) and the 3D runtime both look agents up by
 * id and SILENTLY DROP events for unknown ids - the old a.claude/a.codex/
 * a.cursor ids never animated anything (2026-06-28 audit bug class).
 *
 * Per-step model routing: the brain's plan may pin a model per step (claude: "opus" | "sonnet";
 * codex: e.g. "gpt-5.5").
 *
 * Note: `invoke` throws in a plain browser (no Tauri runtime). Every method that
 * calls invoke must be wrapped in a try/catch by the caller (orchestrator.ts does
 * this at the step level).
 */

import { eventBus } from "@/data/eventBus";
import { pendingAgentNotes } from "./agentNotes";
import type { PraxisEvent } from "@/data/schema";

export type DriverTool = "claude" | "codex" | "cursor";

/** Canonical fleet ids for the three coding drivers (must exist in graph.ts AGENTS). */
export type DriverAgentId = "a.forge" | "a.vega" | "a.quill";

export interface Driver {
  /** Stable fleet agent id - matches graph.ts AGENTS + the per-model tint. */
  readonly id: DriverAgentId;
  /** Tool name forwarded to agent_delegate. */
  readonly tool: DriverTool;
  /** Run a prompt (optionally scoped to a cwd, optionally pinned to a model). An
   *  aborted `signal` kills the running agent CLI itself, not just the wait.
   *  `visible` (Live mode) shows the run where the owner can watch it: Vega's thread in the
   *  Codex app, Forge's session in a terminal window. */
  run(prompt: string, cwd?: string, model?: string, signal?: AbortSignal, opts?: { visible?: boolean; ownedLive?: boolean; followUp?: boolean; sessionKey?: string; taskId?: string; areaId?: string }): Promise<string>;
}

let delegationSeq = 0;
function newDelegationId(tool: DriverTool): string {
  delegationSeq += 1;
  return `${tool}-${Date.now().toString(36)}-${delegationSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Invoke Tauri command, dynamically imported so we never blow up in browser. */
async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

function nowT(): number {
  return performance.now() / 1000;
}

function emitStatus(
  agentId: string,
  status: PraxisEvent["status"],
  extra?: Partial<PraxisEvent>,
): void {
  eventBus.emitOrchestrator({ type: "agent:status", t: nowT(), agentId, status, ...extra });
}

function emitThinking(agentId: string, thought: string, target: Pick<PraxisEvent, "taskId" | "areaId"> = {}): void {
  eventBus.emitOrchestrator({ type: "agent:thinking", t: nowT(), agentId, ...target, thought });
}

/**
 * Sanitize a plan-provided model for the claude CLI.
 *   - haiku in any form → "sonnet" (never route work to haiku - hard rule)
 *   - "opus" / "sonnet" aliases and full "claude-…" ids pass through
 *   - anything else (brain model ids, typos) → undefined → CLI default
 */
export function sanitizeClaudeModel(model?: string): string | undefined {
  if (!model) return undefined;
  const m = model.trim().toLowerCase();
  if (!m) return undefined;
  if (m.includes("haiku")) return "sonnet";
  if (m === "opus" || m === "sonnet" || m.startsWith("claude-")) return m;
  return undefined;
}

// ── Tool failure memory (frontend mirror of hermes_bridge.rs's ONE HANG, PAID ONCE) ──
//
// hermes_bridge.rs classifies a Claude CLI failure (`explain_claude_failure`) and remembers it
// for 120s so the next caller gets the precise reason at once. That memory lives in the Rust
// process and is not queryable from here, so the router could not know a rail was dark until it
// paid for another failure. Not a latch - it expires on its own so a login/install takes effect
// without a restart. Transient errors (a task that timed out, a bad exit on one prompt) are
// never remembered: they say nothing about the next call.

export const TOOL_UNHEALTHY_TTL_MS = 120_000;

export interface ToolFailure {
  /** One sentence that names the fix - what the owner sees. */
  reason: string;
  /** Unix ms when a retry is worth it, when the error said so (usage windows). */
  retryAt?: number;
}

interface RememberedFailure extends ToolFailure {
  at: number;
}

const toolFailures = new Map<DriverTool, RememberedFailure>();

/** Pull a "try again at 2:02 PM" / "resets at 14:02" instant out of an error, if any. */
function parseRetryAt(lower: string, now: number): number | undefined {
  // The preposition is optional: Claude says "resets 9pm (America/New_York)".
  const m = lower.match(/(?:try again|resets?|available|back)\s+(?:(?:at|in|after)\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return undefined;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (!Number.isFinite(h) || h > 23 || min > 59) return undefined;
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * Turn a raw agent_delegate error into a PERSISTENT-condition sentence that
 * names the fix, or null when the error is transient (one bad run) and says
 * nothing about the rail's health. Kept in step with explain_claude_failure.
 */
export function classifyToolFailure(tool: DriverTool, raw: string, now = Date.now()): ToolFailure | null {
  const lower = raw.toLowerCase();
  const name = tool === "claude" ? "Claude CLI" : tool === "codex" ? "Codex CLI" : "cursor-agent";

  if (/not installed|not found or failed to spawn|no such file|is not recognized|enoent/.test(lower)) {
    if (tool === "cursor") {
      return { reason: "cursor-agent is not installed on this machine — install it with: irm 'https://cursor.com/install?win32=true' | iex" };
    }
    if (tool === "codex") return { reason: "Codex CLI is not installed — run: npm i -g @openai/codex" };
    return { reason: "Claude CLI is not installed — install Claude Code and run `claude` once to sign in" };
  }
  if (/refusing claude code/.test(lower)) {
    return { reason: "The vendor is refusing Claude Code, so Forge can't run - route to Codex or Cursor until it clears" };
  }
  if (/not logged in|not signed in|signed out|unauthenticated|authentication (?:failed|required)|invalid (?:api )?key|\/login\b|unauthorized|401\b|please (?:log|sign) in|login required/.test(lower)) {
    if (tool === "codex") return { reason: "Codex CLI is not logged in — run `codex login` in a terminal" };
    if (tool === "cursor") return { reason: "cursor-agent is not signed in — run `cursor-agent login` in a terminal" };
    return { reason: "the Claude CLI is not signed in — run `claude` in a terminal and `/login`" };
  }
  if (/breaker|rail.*(?:disabled|switched off)/.test(lower)) return { reason: `${name} is unavailable: ${raw}` };
  // "hit your SESSION limit" is Claude Pro's 5-hour window, which it shares with the owner's own
  // Claude sessions. Unrecognised, it cost a whole run on 2026-09-16: Forge finished its step,
  // exited 1 on "You've hit your session limit · resets 9pm", and the next Claude step was sent
  // anyway.
  if (/usage limit|rate limit|quota|too many requests|\b429\b|limit reached|hit your (?:[\w-]+ )?limit|out of credits|insufficient credits|no credits|out of (?:weekly |5h )?usage/.test(lower)) {
    const retryAt = parseRetryAt(lower, now);
    const until = retryAt ? ` until ${formatClock(retryAt, now)}` : "";
    const f: ToolFailure = { reason: `${name === "cursor-agent" ? "Cursor" : name.replace(" CLI", "")} is out of usage${until} — wait for the window to reset or route elsewhere` };
    if (retryAt) f.retryAt = retryAt;
    return f;
  }
  if (tool === "claude" && /did not respond|didn't answer|timed out|timeout/.test(lower)) {
    // hermes_bridge.rs treats a silent Claude CLI as persistent (it will not answer
    // the next caller either); mirror that. Codex/cursor timeouts are long tasks,
    // not a dead rail, so they are NOT remembered.
    return { reason: "the Claude CLI did not respond — it is installed but not answering; check `claude` in a terminal" };
  }
  return null;
}

/** "2:02 PM" today, or "Sat 9/19 9:02 AM" when the instant is on another day. */
export function formatClock(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" })} ${time}`;
}

/** Remember a classified persistent failure. Transient errors are ignored. */
export function noteToolFailure(tool: DriverTool, raw: string, now = Date.now()): ToolFailure | null {
  const f = classifyToolFailure(tool, raw, now);
  if (f) toolFailures.set(tool, { ...f, at: now });
  return f;
}

/** A success proves the rail works; forget any remembered failure at once. */
export function noteToolHealthy(tool: DriverTool): void {
  toolFailures.delete(tool);
}

/**
 * The remembered failure, if it is still fresh: within the TTL, or - when the
 * error named a reset instant - until that instant (capped at 6h so a misparsed
 * time can never dark a rail for a day).
 */
export function rememberedToolFailure(tool: DriverTool, now = Date.now()): (ToolFailure & { ageMs: number }) | null {
  const f = toolFailures.get(tool);
  if (!f) return null;
  const horizon = f.retryAt
    ? Math.min(f.retryAt, f.at + 6 * 60 * 60_000)
    : f.at + TOOL_UNHEALTHY_TTL_MS;
  if (now >= horizon) {
    toolFailures.delete(tool); // expired - the next caller pays a real attempt
    return null;
  }
  const { at, ...rest } = f;
  return { ...rest, ageMs: now - at };
}

/** Test/diagnostic reset - never called by product code. */
export function forgetAllToolFailures(): void {
  toolFailures.clear();
}

/** The model string emitted on agent:status(working) so the chip tints per model. */
function tintModel(tool: DriverTool, model?: string): string | undefined {
  if (tool === "claude") return sanitizeClaudeModel(model); // "opus"/"sonnet" resolve a family
  if (tool === "codex") return "codex";
  return "cursor";
}

function makeDriver(id: DriverAgentId, tool: DriverTool): Driver {
  return {
    id,
    tool,
    async run(prompt: string, cwd?: string, model?: string, signal?: AbortSignal, opts?: { visible?: boolean; ownedLive?: boolean; followUp?: boolean; sessionKey?: string; taskId?: string; areaId?: string }): Promise<string> {
      const t = nowT();
      const target = { taskId: opts?.taskId, areaId: opts?.areaId };
      emitStatus(id, "working", { ...target, model: tintModel(tool, model) });
      emitThinking(id, `▶ ${tool}: ${prompt.slice(0, 72)}${prompt.length > 72 ? "…" : ""}`, target);
      eventBus.emitOrchestrator({ type: "task:start", t, agentId: id, ...target, label: tool });

      // Aborting the run must stop the agent CLI, not merely stop waiting for it:
      // live 2026-09-16 a stopped run's agent kept editing the workspace for minutes.
      const delegationId = newDelegationId(tool);
      const stopAgent = () => {
        void tauriInvoke<string>("agent_delegate_abort", { delegationId }).catch(() => {});
        if (opts?.ownedLive && tool !== "cursor") void tauriInvoke<string>("live_operate_abort", { delegationId }).catch(() => {});
      };
      // An already-aborted owner must reach the backend cancellation registry
      // before this driver can submit anything. This preserves the exact ID the
      // active-run abort path uses and prevents a late dynamic import from
      // admitting an owned chat after its owner has stopped it.
      if (signal?.aborted) {
        stopAgent();
        emitStatus(id, "idle", target);
        throw new Error("Stopped by owner before tool admission.");
      }
      signal?.addEventListener("abort", stopAgent, { once: true });

      // Notes the owner left for this agent on the Flight Deck ride along with its next job
      // (agentNotes.ts); they count as read only once the job actually ran.
      const notes = await pendingAgentNotes(tool, (agentId) => tauriInvoke<unknown[]>("agent_chat_read", { agentId }));
      const job = notes.preamble + prompt;
      if (notes.count) emitThinking(id, `✉ ${tool}: +${notes.count} note${notes.count === 1 ? "" : "s"} from Zach`, target);

      try {
        // LIVE team work is a separate owned desktop-session contract. HYBRID
        // continues through agent_delegate even when it is visibly shown.
        // Quill has no on-screen driver yet (Cursor's agent panel isn't operated by Praxis):
        // in LIVE it runs the checked headless path and is SHOWN, like Hybrid, instead of failing.
        if (opts?.ownedLive && tool !== "cursor") {
          if (!cwd) throw new Error("LIVE owned-session step requires a workspace folder.");
          const result = await tauriInvoke<string>("live_operate_step", {
            agent: tool, folder: cwd, prompt: job, followUp: opts.followUp === true, delegationId,
            model: tool === "claude" ? sanitizeClaudeModel(model) : undefined,
            sessionKey: opts.sessionKey,
          });
          noteToolHealthy(tool);
          notes.markRead();
          if (!opts?.taskId) eventBus.emitOrchestrator({ type: "task:complete", t: nowT(), agentId: id });
          emitStatus(id, "done", target);
          return result;
        }
        const args: Record<string, unknown> = { tool, prompt: job, delegationId };
        if (cwd) args.cwd = cwd;
        // Per-step model from the brain's plan. claude gets a sanitized alias
        // (opus/sonnet, never haiku); codex takes the model verbatim (e.g.
        // "gpt-5.5") - omitted, both CLIs fall back to their configured default.
        const routed = tool === "claude" ? sanitizeClaudeModel(model) : model?.trim() || undefined;
        if (routed) args.model = routed;
        if (opts?.visible) args.visible = true;
        const result = await tauriInvoke<string>("agent_delegate", args);
        noteToolHealthy(tool); // it answered - forget any remembered failure
        notes.markRead();
        if (!opts?.taskId) eventBus.emitOrchestrator({ type: "task:complete", t: nowT(), agentId: id });
        emitStatus(id, "done", target);
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // A one-off failure is not.
        const persistent = noteToolFailure(tool, msg);
        emitThinking(id, `✗ ${tool}: ${(persistent?.reason ?? msg).slice(0, 96)}`, target);
        emitStatus(id, "idle", target);
        throw err;
      } finally {
        signal?.removeEventListener("abort", stopAgent);
      }
    },
  };
}

export const claudeDriver: Driver = makeDriver("a.forge", "claude");
export const codexDriver: Driver = makeDriver("a.vega", "codex");
export const cursorDriver: Driver = makeDriver("a.quill", "cursor");

/** Lookup by tool name - orchestrate() uses this to resolve steps. */
export const DRIVERS: Record<DriverTool, Driver> = {
  claude: claudeDriver,
  codex: codexDriver,
  cursor: cursorDriver,
};
