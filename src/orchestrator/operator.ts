/**
 * operator - Praxis operates the computer from TYPED text.
 *
 * They now run on the machinery Atlas uses:
 *
 * Silent by design: every step and the outcome land in Mission; Atlas speaks only when
 * Atlas was the one asked. Stoppable from the Mission strip like any mission.
 */

import { praxisSay } from "./missionThread";
import { registerMission, finishMission } from "./missionControl";
import { selectedBrain } from "./brain";
import type { HybridFeedItem } from "@/voice/hybridRouter";

/** Atlas tools the typed operator may use. Screenshots are left out - the text brain
 *  can't see them; it reads the screen through window and UI-element lists instead. */
export const OPERATOR_TOOLS = [
  "open_app",
  "open_url",
  "web_search",
  "focus_window",
  "list_windows",
  "list_elements",
  "click_element",
  "type_text",
  "fill_field",
  "press_key",
  "scroll",
  "window_control",
  "clear_popups",
  "praxis_command",
  "recall_memory",
] as const;

/** Most steps a typed task may take before Praxis stops and says where it got to. */
export const OPERATOR_MAX_STEPS = 8;

export interface OperatorStep {
  tool: string;
  args: Record<string, unknown>;
  result: string;
}

export type OperatorDecision =
  | { kind: "tool"; tool: string; args: Record<string, unknown> }
  | { kind: "done"; ok: boolean; summary: string };

/** The next-step prompt for the operator brain. Pure (tested). */
export function operatorPrompt(goal: string, steps: OperatorStep[], tools: { name: string; description: string; params: string }[]): string {
  return [
    "You are Praxis operating Zach's Windows PC for him, one action at a time.",
    `His request: ${goal.slice(0, 500)}`,
    "",
    "Tools (call exactly ONE per turn):",
    ...tools.map((t) => `- ${t.name}(${t.params}): ${t.description.slice(0, 220)}`),
    "",
    "Rules: Zach typed this into Praxis, so Praxis's own window has the keyboard focus right now — open or focus the target app or window BEFORE typing, pressing keys or scrolling. Read the screen with list_windows / list_elements before clicking, and click by the element's accessible name. Never type passwords, card numbers or other secrets, never send messages or buy anything — stop and say what Zach needs to do instead. Do not run shell commands or edit files yourself; only these tools act.",
    "",
    steps.length ? "What happened so far:" : "Nothing has been done yet.",
    ...steps.map((s, i) => `${i + 1}. ${s.tool} ${JSON.stringify(s.args)} → ${s.result.slice(0, 400)}`),
    "",
    'Return ONLY valid JSON (no prose, no markdown fences): {"tool":"<name>","args":{...}} for the next action, or {"done":true,"summary":"what you did, one line"} when the request is met, or {"done":false,"summary":"why you stopped, one line"} when you cannot go on.',
  ].join("\n");
}

/** Parse the brain's next step. Null when unusable. Pure (tested). */
export function parseOperatorDecision(raw: string, allowed: readonly string[] = OPERATOR_TOOLS): OperatorDecision | null {
  try {
    const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const obj = JSON.parse(text) as { tool?: unknown; args?: unknown; done?: unknown; summary?: unknown };
    if (typeof obj.done === "boolean") {
      return { kind: "done", ok: obj.done, summary: typeof obj.summary === "string" ? obj.summary.trim().slice(0, 240) : "" };
    }
    if (typeof obj.tool !== "string" || !allowed.includes(obj.tool)) return null;
    const args = obj.args && typeof obj.args === "object" && !Array.isArray(obj.args) ? (obj.args as Record<string, unknown>) : {};
    return { kind: "tool", tool: obj.tool, args };
  } catch {
    return null;
  }
}

function paramsOf(spec: { parameters?: { properties?: Record<string, unknown>; required?: string[] } }): string {
  const props = Object.keys(spec.parameters?.properties ?? {});
  const required = new Set(spec.parameters?.required ?? []);
  return props.map((p) => (required.has(p) ? p : `${p}?`)).join(", ");
}

/** Did the fast router finish the request (acted, answered, or captured it)? */
function routerHandled(item: HybridFeedItem): boolean {
  return item.resolution === "command" || item.resolution === "action" || item.resolution === "answer" || item.resolution === "todo";
}

/**
 * Run one typed desktop request to the end and report it in Mission. Never throws.
 */
export async function operateTyped(
  goal: string,
  opts: {
    missionId: string;
    ownerToken?: string;
    /** This outcome ends the mission (false while more tasks or a build share it). */
    closes?: boolean;
  },
): Promise<{ done: boolean; stopped: boolean; summary: string }> {
  const control = registerMission(opts.missionId);
  const signal = control.signal;
  const finish = async (done: boolean, summary: string) => {
    const stopped = signal.aborted;
    const ok = done && !stopped;
    const text = stopped ? "Stopped — you stopped this before it finished." : summary;
    const status = opts.closes === false ? "running" : ok ? "done" : "failed";
    await praxisSay(opts.missionId, ok ? "answer" : "failure", text, { status });
    return { done: ok, stopped, summary: text };
  };
  try {
    const { routeHybridUtterance } = await import("@/voice/hybridRouter");
    const { dispatchToolCall, HYBRID_TOOL_SPECS } = await import("@/voice/hybridTools");
    const { stopOperatorRuns, stopAllOperatorRuns } = await import("@/voice/stopOperatorRuns");
    const onHalt = () => (opts.ownerToken ? stopOperatorRuns(opts.ownerToken) : stopAllOperatorRuns());

    // 1) The fast router: instant, free, the same rungs Atlas's voice lane uses.
    const said: string[] = [];
    const transport = {
      ownsInput: false,
      say: (text: string) => {
        if (text.trim()) said.push(text.trim());
        return Promise.resolve();
      },
      isSpeaking: () => false,
      stopSpeaking: () => {},
      onSpeakingChange: () => () => {},
    };
    let routed: HybridFeedItem | null = null;
    const item = await routeHybridUtterance(goal, {
      transport,
      signal,
      ownerToken: opts.ownerToken,
      onHalt,
      emit: (i) => {
        routed = i;
      },
      typed: true,
    });
    const first = routed ?? item;
    if (signal.aborted || first.resolution === "halt") return finish(false, "");
    if (routerHandled(first)) {
      return finish(true, first.displayMarkdown || first.detail || said.join(" ") || "Done.");
    }
    if (first.resolution === "blocked") {
      // A trust gate, the HALT breaker, or a failed local action - the loop below would
      // hit the same wall, so say why instead of spending brain calls on it.
      return finish(false, first.detail || said.join(" ") || "That was blocked.");
    }
    if (first.resolution === "escalated" || first.resolution === "unattended") {
      // Handed to a run of its own (the real-browser loop, or an unattended run).
      return finish(true, first.detail || said.join(" ") || "Handed off — it's running now.");
    }

    // 2) The operator loop: Praxis's brain drives Atlas's tools one step at a time.
    const tools = HYBRID_TOOL_SPECS.filter((s) => (OPERATOR_TOOLS as readonly string[]).includes(s.name)).map((s) => ({
      name: s.name,
      description: s.description,
      params: paramsOf(s as { parameters?: { properties?: Record<string, unknown>; required?: string[] } }),
    }));
    const steps: OperatorStep[] = [];
    const { invoke } = await import("@tauri-apps/api/core");
    for (let i = 0; i < OPERATOR_MAX_STEPS; i++) {
      if (signal.aborted) return finish(false, "");
      const brain = selectedBrain();
      let raw: string;
      try {
        raw = await invoke<string>("hermes_brain", { goal: operatorPrompt(goal, steps, tools), model: brain.model, provider: brain.provider, fallbacks: brain.fallbacks });
      } catch (err) {
        return finish(false, `I couldn't reach my brain to work out the next step: ${String(err).slice(0, 160)}`);
      }
      if (signal.aborted) return finish(false, "");
      const decision = parseOperatorDecision(raw);
      if (!decision) return finish(false, "I couldn't work out a safe next step for that — try saying it more specifically.");
      if (decision.kind === "done") {
        return finish(decision.ok, decision.summary || (decision.ok ? "Done." : "I couldn't finish that."));
      }
      const res = await dispatchToolCall(decision.tool, decision.args, onHalt, signal, opts.ownerToken);
      steps.push({ tool: decision.tool, args: decision.args, result: res.output });
      await praxisSay(opts.missionId, "note", `→ ${decision.tool.replace(/_/g, " ")} — ${res.output.slice(0, 280)}`);
      if (res.resolution === "halt") return finish(false, "");
    }
    return finish(false, `I took ${OPERATOR_MAX_STEPS} steps and it still isn't done — here's where I got to: ${steps[steps.length - 1]?.result.slice(0, 200) ?? "nothing worked"}.`);
  } catch (err) {
    return finish(false, `Something went wrong while operating the computer: ${String(err).slice(0, 200)}`);
  } finally {
    finishMission(opts.missionId, control);
  }
}
