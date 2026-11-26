/**
 *
 * Two reply paths, routed by intent:
 *   DEFAULT (question / guidance / quick ask) - a persona-framed `brain_chat` call:
 *     the agent answers IN CHARACTER (its name, role, model, live focus/lane/status,
 *     + the last ~10 thread turns) so the reply reads as "talking to Forge", not a
 *     generic bot. Reuses `selectedBrain()` - never a second brain seam.
 *   WORK ORDER (do something substantial) - acknowledged in-thread, then handed to
 *     the REAL `orchestrate()` loop (src/orchestrator/orchestrator.ts) with a context
 *     prefix naming the agent + its current focus, so the run gets the normal
 *     ledger/run-notes/supervision treatment. The thread gets a "handed to the
 *     orchestrator" line immediately, then a completion line when the run resolves
 *     (best-effort - orchestrate() already streams to the session panel/eventBus
 *     independently, so this is a convenience echo, not the source of truth).
 *
 * Intent routing mirrors the existing patterns rather than reinventing them:
 *   - the regex tier is the same shape as respond.ts's BUILD_RE / isBuildIntent
 *     (a small set of imperative verbs signal "do this", not "tell me about it").
 *   - the brain-classify fallback for ambiguous text mirrors hybridClassify.ts's
 *     classifyPrompt/parseClassify contract (ask the fast brain to bucket the
 *     utterance, tolerant JSON parse, safe default on any failure).
 *
 */

import type { BrainRail } from "@/orchestrator/brain";
import type { AgentRow } from "@/shared/agents";
import { MODEL_LABEL } from "@/shared/agents";
import { fleetDefForAgent, getFleetSelection } from "@/command/fleetStore";
import { boardRouteForSelection } from "@/orchestrator/boardContributors";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ChatRole = "zach" | "agent";

export interface ChatMessage {
  role: ChatRole;
  text: string;
  ts: number;
  meta?: { operatorDirected?: boolean; kind?: "default" | "work-order" };
}

/** Raw JSONL row shape returned by the Rust `agent_chat_read` command. */
interface RawChatMessage {
  role: string;
  text: string;
  ts: number;
  meta?: unknown;
}

/**
 * Narrow a stored `meta` instead of asserting it.
 *
 * Two writers use this field with different shapes: work-order rows store an
 * object (`{ kind, operatorDirected }`), and VOICE rows store a plain string -
 * the turn's resolution. The old code cast every value to the object shape, so
 * `m.meta?.kind` on a voice row read a property off a string and quietly got
 * undefined. Never a crash, which is why it survived; just a type that was not
 * true about half the rows in the file.
 */
function coerceChatMeta(v: unknown): ChatMessage["meta"] {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const kind = o.kind === "work-order" || o.kind === "default" ? o.kind : undefined;
  const operatorDirected =
    typeof o.operatorDirected === "boolean" ? o.operatorDirected : undefined;
  if (kind === undefined && operatorDirected === undefined) return undefined;
  return { kind, operatorDirected };
}

// ── Tauri plumbing (defensive - safe to import from a plain browser) ─────────

function inTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Load an agent's persisted thread (oldest-first). Empty array outside Tauri or on any failure. */
export async function loadThread(agentId: string): Promise<ChatMessage[]> {
  if (!inTauri()) return [];
  try {
    const rows = await tauriInvoke<RawChatMessage[]>("agent_chat_read", { agentId });
    return rows.map((r) => ({
      role: r.role === "zach" ? "zach" : "agent",
      text: r.text,
      ts: r.ts,
      meta: coerceChatMeta(r.meta),
    }));
  } catch {
    return [];
  }
}

/** Persist one message to the agent's thread. Best-effort - a failure never blocks the UI. */
async function persistMessage(agentId: string, msg: ChatMessage): Promise<void> {
  if (!inTauri()) return;
  try {
    await tauriInvoke("agent_chat_append", {
      agentId,
      role: msg.role,
      text: msg.text,
      meta: msg.meta ?? null,
    });
  } catch {
    /* best-effort - dev browser / command missing */
  }
}

// ── Intent routing ────────────────────────────────────────────────────────────

export type ChatIntent = "default" | "work-order";

/**
 * Regex tier - same shape as respond.ts's BUILD_RE: a small set of imperative
 * verbs that mean "go DO this" rather than "tell me about it". Deliberately
 * anchored to word boundaries so e.g. "what did you build" doesn't false-positive
 * (BUILD_RE-style tiers are intent signals, not exhaustive grammars - ambiguous
 * text falls through to the brain classify below).
 */
const WORK_ORDER_RE =
  /\b(build|create|make|add|implement|write|generate|scaffold|ship|fix|refactor|update|deploy|run|execute|start|delegate|go do|handle|automate|migrate|set up|wire up)\b/i;

/**
 * Local/tone hints that this is a QUESTION, not a work order, even if a verb
 * above also fires (e.g. "can you fix this?" - mostly a status check; "why did
 * the build fail" names "build" but is clearly asking, not ordering). Checked
 * first so a leading question word wins over an incidental verb match.
 */
const QUESTION_RE = /^\s*(?:what|why|how|when|where|who|which|is|are|do|does|did|can|could|should|would)\b.*\?\s*$/i;

/**
 * Classify a message's intent with ZERO latency (no model) when the shape is
 * unambiguous. Returns null when the brain should decide (mirrors
 * hybridClassify's local-first-then-brain ladder).
 */
export function classifyIntentLocal(text: string): ChatIntent | null {
  const t = text.trim();
  if (!t) return "default";
  if (QUESTION_RE.test(t)) return "default";
  if (WORK_ORDER_RE.test(t)) return "work-order";
  // Short imperative-mood sentences without a "?" and starting with a bare verb
  // ("go clean up the vault", "delegate this to Vega") also read as orders even
  // when they miss the verb list above - but that's exactly the ambiguous case
  // the brain classify exists for, so don't over-fit the regex tier further.
  return null;
}

/** The brain-classify prompt for an ambiguous message - tight, single-line JSON,
 *  same contract shape as hybridClassify.ts's classifyPrompt. */
function classifyPrompt(text: string): string {
  return [
    "Classify this message a user just typed directly to one of their AI coding agents.",
    'Reply with ONE line of minified JSON, no prose, no fences: {"intent":"WORK_ORDER"|"DEFAULT"}',
    "- WORK_ORDER: the user wants the agent to actually DO substantial work (build/fix/change something real, multi-step).",
    "- DEFAULT: a question, quick ask, guidance, or anything answerable in a reply without doing real work.",
    "",
    `Message: ${text}`,
  ].join("\n");
}

function parseIntentReply(raw: string): ChatIntent {
  try {
    const body = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const obj = JSON.parse(body) as { intent?: unknown };
    if (typeof obj.intent === "string" && obj.intent.toUpperCase() === "WORK_ORDER") return "work-order";
  } catch {
    if (/WORK_ORDER/i.test(raw)) return "work-order";
  }
  return "default";
}

/** Full intent classification: local regex tier first, brain classify fallback
 *  for ambiguous text. Never throws - any brain failure defaults to "default"
 *  (the safer path: a missed work order still gets a helpful reply + the owner can
 *  just ask again more directly; a wrongly-escalated question would be worse). */
export async function classifyIntent(text: string): Promise<ChatIntent> {
  const local = classifyIntentLocal(text);
  if (local) return local;
  if (!inTauri()) return "default";
  try {
    const { selectedBrain } = await import("@/orchestrator/brain");
    const { model, provider, fallbacks } = selectedBrain();
    const raw = await tauriInvoke<string>("brain_chat", {
      message: classifyPrompt(text),
      context: null,
      model,
      provider,
      fallbacks,
    });
    return parseIntentReply(raw);
  } catch {
    return "default";
  }
}

// ── Persona reply (DEFAULT path) ──────────────────────────────────────────────

/** Resolve the agent's focus label for the persona prompt (mirrors Cockpit's
 *  resolveFocusNode fallback chain, simplified to a label string). */
function focusLabel(agent: AgentRow): string {
  return agent.focus || agent.task || "nothing in particular right now";
}

/** The provider/model that will ACTUALLY answer for this agent.
 *
 *  The chat header's model chip writes the fleet selection for this agent, so the
 *  reply has to come from that selection - otherwise the dropdown sitting on top
 *  of the thread changes a label and nothing else, while the globally-selected
 *  brain quietly answers instead.
 *
 *  persona prompt can state the truth rather than a guess. */
async function chatRouteFor(
  agent: AgentRow,
): Promise<{ provider: string; model?: string; label: string; fromFleet: boolean; fallbacks: BrainRail[] }> {
  const { selectedBrain, brainOrder } = await import("@/orchestrator/brain");
  const fallback = () => {
    const { model, provider, fallbacks } = selectedBrain();
    return { provider, model, label: model || provider, fromFleet: false, fallbacks };
  };
  const def = fleetDefForAgent(agent);
  if (!def) return fallback();
  const selection = getFleetSelection(def.key);
  if (!selection) return fallback();
  const route = boardRouteForSelection(selection);
  if (route.error || !route.provider || route.provider === "unavailable") return fallback();
  const fallbacks = brainOrder({ provider: route.provider, model: route.model ?? "" });
  return { provider: route.provider, model: route.model, label: selection.label, fromFleet: true, fallbacks };
}

/** Build the persona system context - the agent's identity + Praxis's own live
 *  briefing on it, so the reply MERGES the owner's new message with what Praxis
 *  already knows/said about this agent, never replacing one with the other. */
function personaSystemContext(agent: AgentRow, history: ChatMessage[], modelLabelOverride?: string): string {
  // State the model that is ACTUALLY serving this turn. The roster row's family
  // label describes the coding session the agent is attached to, which is not
  // necessarily what answers here - asserting it made the persona claim to be a
  // model that was not on the call.
  const modelLabel =
    modelLabelOverride ?? (agent.family ? MODEL_LABEL[agent.family] : agent.model || "default model");
  const recent = history.slice(-10).map((m) => `${m.role === "zach" ? "Zach" : agent.name}: ${m.text}`);
  return [
    `You are ${agent.name}, a named agent in Zach's Praxis fleet — role: ${agent.role}.`,
    `Model: ${modelLabel}. Status: ${agent.status}. Lane: ${agent.lane ?? "none"}. Current focus: ${focusLabel(agent)}.`,
    `Areas you touch: ${agent.touches.join(", ") || "none yet"}.`,
    "Praxis (the orchestrator) already tracks your live state above — when you reply, MERGE that",
    "live context with whatever Zach just asked; never ignore your own current focus/lane/task, and",
    "never ignore what Zach just said. If his message conflicts with what you're currently doing,",
    "acknowledge both explicitly (what you were doing + what he now wants).",
    "Speak in the first person as this agent: concise, direct, a little personality, never generic",
    "chatbot filler. 1-4 sentences unless the question needs more.",
    recent.length ? "\nRecent thread:\n" + recent.join("\n") : "",
  ].join("\n");
}

/** DEFAULT path: answer in-character via the shared brain seam. Never throws -
 *  returns a safe fallback line so the thread always gets a reply. */
async function replyAsPersona(agent: AgentRow, text: string, history: ChatMessage[]): Promise<string> {
  if (!inTauri()) {
    return `(offline) I'd answer that, but the orchestrator runtime isn't available right now.`;
  }
  try {
    const route = await chatRouteFor(agent);
    const { model, provider, fallbacks } = route;
    const reply = await tauriInvoke<string>("brain_chat", {
      message: text,
      context: personaSystemContext(agent, history, route.label),
      model,
      provider,
      fallbacks,
    });
    return reply.trim() || `${agent.name} had nothing to add.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${agent.name} couldn't reach the brain just now (${msg.slice(0, 80)}). Try again in a moment.`;
  }
}

// ── Work-order handoff ────────────────────────────────────────────────────────

/**
 * WORK ORDER path: hand the instruction to the real orchestrate() loop with a
 * context prefix naming the agent + its current focus, so the run's plan/verify
 * prompts (and any human reading the ledger) know this goal originated as a
 * direct instruction TO a specific agent, not a bare ask. Fire-and-forget from
 * the caller's perspective - orchestrate() streams its own progress via
 * eventBus/the session panel; this function resolves when the run completes so
 * the caller can post a completion line to the thread.
 */
export function buildWorkOrderGoal(agent: AgentRow, text: string): string {
  return [
    `Direct instruction to ${agent.name} (${agent.role}) — currently: ${focusLabel(agent)}${agent.lane ? ` on ${agent.lane}` : ""}.`,
    `Zach told ${agent.name} directly: ${text}`,
  ].join(" ");
}

export async function dispatchWorkOrder(agent: AgentRow, text: string) {
  const { orchestrate } = await import("@/orchestrator/orchestrator");
  return orchestrate(buildWorkOrderGoal(agent, text));
}

// ── Run notes + Hermes teach (operator-directed exchanges) ───────────────────

/**
 * Write a run note for an operator-directed exchange - mirrors orchestrator.ts's
 * recordRun → write_run_note call exactly (same RunNoteEntry shape: goal, steps,
 * models, done, ts). "steps" here is a single synthetic step describing the
 * chat turn itself, since a chat reply isn't a delegated tool call - but the
 * note still lands in the SAME vault runs/ folder so it becomes a first-class
 * Memory Galaxy node and every agent (and Praxis) can see this was operator-
 * directed, not the agent's own initiative.
 */
async function writeOperatorRunNote(agent: AgentRow, instruction: string, outcome: string, ok: boolean): Promise<void> {
  if (!inTauri()) return;
  try {
    await tauriInvoke("write_run_note", {
      entry: {
        goal: `Zach direct instruction: ${instruction}`.slice(0, 500),
        steps: [
          {
            tool: "claude",
            model: agent.family ?? null,
            ok,
          },
        ],
        models: agent.family ? [agent.family] : [],
        done: ok,
        ts: Date.now(),
      },
    });
  } catch {
    /* vault write unavailable - non-fatal, mirrors orchestrator.ts's own guard */
  }
  void outcome; // kept for signature symmetry / future richer note body
}

/**
 * Teach Hermes a durable lesson from an operator-directed exchange - same gate
 * orchestrator.ts's teachHermesFromRun uses (best-effort, target "user" since
 * this is the owner's own correction/preference, not an environmental fact).
 */
async function teachHermesIfDurable(agent: AgentRow, instruction: string): Promise<void> {
  if (!inTauri()) return;
  const lesson = `Zach gave ${agent.name} (${agent.role}) a direct instruction: ${instruction}`.slice(0, 500);
  try {
    await tauriInvoke("hermes_teach", { lesson, target: "user" });
  } catch {
    /* Hermes off/unavailable - never blocks the chat result */
  }
}

/**
 * Heuristic: does this instruction express a durable preference/correction
 * worth teaching Hermes, vs. a one-off quick ask? Kept intentionally narrow -
 * only phrasings that read as a standing rule/correction qualify, so routine
 * chat doesn't spam Hermes's tight memory budget (same caution orchestrator.ts
 * takes with teachHermesFromRun - "not every run", only genuinely durable ones).
 */
const DURABLE_PREFERENCE_RE =
  /\b(from now on|always|never|instead of|stop doing|don'?t do|remember (?:that|to)|prefer|going forward|as a rule|by default)\b/i;

export function isDurablePreference(text: string): boolean {
  return DURABLE_PREFERENCE_RE.test(text);
}

// ── Public entry point ────────────────────────────────────────────────────────

export interface SendResult {
  reply: ChatMessage;
  /** Present when this turn was routed to the orchestrator - the caller can
   *  await it to post a completion line, or ignore it and let the session
   *  panel/eventBus carry the rest (the run is already in motion either way). */
  workOrder?: ReturnType<typeof dispatchWorkOrder>;
}

/**
 * Send the owner's message to `agent`: persists his line (tagged operator-directed),
 * classifies intent, produces a reply (persona chat or orchestrator handoff),
 * persists the reply, and - for exchanges that produced a real decision/outcome
 * or express a durable preference - writes a run note + teaches Hermes.
 *
 * `history` is the thread BEFORE this turn (oldest-first) - used for the
 * persona's recent-context window; the caller owns re-fetching/appending to its
 * own displayed state.
 */
export async function sendToAgent(agent: AgentRow, text: string, history: ChatMessage[]): Promise<SendResult> {
  const trimmed = text.trim();
  const zachMsg: ChatMessage = {
    role: "zach",
    text: trimmed,
    ts: Date.now(),
    meta: { operatorDirected: true },
  };
  await persistMessage(agent.id, zachMsg);

  const intent = await classifyIntent(trimmed);

  if (intent === "work-order") {
    const ackText = `Handed to the orchestrator — watch the session feed. (${agent.name}: ${focusLabel(agent)})`;
    const ack: ChatMessage = { role: "agent", text: ackText, ts: Date.now(), meta: { kind: "work-order" } };
    await persistMessage(agent.id, ack);

    // Fire the real run; caller may await workOrder to post a completion line.
    const workOrder = dispatchWorkOrder(agent, trimmed)
      .then(async (result) => {
        const doneText = result.done
          ? `Done — ${result.summary || "goal verified."}`
          : `Stopped without full verification — ${result.summary || "see the session feed for details."}`;
        const doneMsg: ChatMessage = { role: "agent", text: doneText, ts: Date.now(), meta: { kind: "work-order" } };
        await persistMessage(agent.id, doneMsg);
        await writeOperatorRunNote(agent, trimmed, doneText, result.done);
        if (isDurablePreference(trimmed)) await teachHermesIfDurable(agent, trimmed);
        return result;
      })
      .catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        const failText = `The orchestrator run failed to start: ${msg.slice(0, 120)}`;
        await persistMessage(agent.id, { role: "agent", text: failText, ts: Date.now(), meta: { kind: "work-order" } });
        throw err;
      });

    return { reply: ack, workOrder };
  }

  // DEFAULT path - persona chat reply, merging live roster context + the ask.
  const replyText = await replyAsPersona(agent, trimmed, [...history, zachMsg]);
  const reply: ChatMessage = { role: "agent", text: replyText, ts: Date.now(), meta: { kind: "default" } };
  await persistMessage(agent.id, reply);

  if (isDurablePreference(trimmed)) {
    await writeOperatorRunNote(agent, trimmed, replyText, true);
    await teachHermesIfDurable(agent, trimmed);
  }

  return { reply };
}
